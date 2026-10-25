import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';            // ← adapte le chemin
import { requireAuth } from '../../middlewares/auth';  // ← adapte le chemin

console.log('SYNC ROUTER v2 chargé');

const router = Router();
router.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SyncError extends Error {}

// Essence : un seul crédit ouvert par client, sauf si 50 % ont été remboursés.
// Bateau Vente Poisson et autres activités : aucune limite.
const SEUIL_REMBOURSEMENT_ESSENCE = 0.5;

function estEssence(nom: string) {
  return nom
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .includes('essence');
}

type Operation = {
  opId: string;
  entity: string;
  entityId: string;
  op: string;          // 'upsert' | 'delete' | 'stock_adjust' | 'remboursement' | 'remb_financement'
  payload: any;
};

// handlers[entité][nom d'opération] = fonction qui applique l'opération.
// Chaque fonction reçoit (id, payload, userId) et lève une SyncError pour un refus métier
// (le push la renvoie telle quelle au mobile), ou toute autre erreur pour un vrai échec technique
// (le mobile réessaiera plus tard, rien n'est marqué "refusé").
const handlers: Record<string, Record<string, (id: string, payload: any, userId: string) => Promise<void>>> = {
   clients: {
    async upsert(id, p) {
      const nom = String(p.nom ?? '').trim();
      const contact = p.contact ? String(p.contact).trim() : null;
      const activiteId = String(p.activiteId || '');
      if (!nom) throw new SyncError('Le nom du client est requis.');
      if (!activiteId) throw new SyncError("Activité requise pour le client. Mettez l'application à jour.");

      const doublonNom = await prisma.client.findFirst({
        where: { activiteId, deletedAt: null, id: { not: id }, nom: { equals: nom, mode: 'insensitive' } },
      });
      if (doublonNom) throw new SyncError('Un client avec ce nom existe déjà dans cette activité.');

      if (contact) {
        const doublonContact = await prisma.client.findFirst({
          where: { activiteId, deletedAt: null, id: { not: id }, contact },
        });
        if (doublonContact) throw new SyncError('Un client avec ce contact existe déjà dans cette activité.');
      }

      await prisma.client.upsert({
        where: { id },
        create: { id, activiteId, nom, contact },
        update: { nom, contact, deletedAt: null },
      });
    },
    async delete(id) {
      const existant = await prisma.client.findUnique({ where: { id } });
      if (!existant || existant.deletedAt) return;
      const [ventes, credits] = await Promise.all([
        prisma.vente.count({ where: { clientId: id } }),
        prisma.credit.count({ where: { clientId: id } }),
      ]);
      if (ventes > 0 || credits > 0) {
        throw new SyncError('Client lié à des ventes ou des crédits : suppression refusée.');
      }
      await prisma.client.update({ where: { id }, data: { deletedAt: new Date() } });
    },
  },

  // Produit (article) : un nom par activité. Il contient des sessions (table "produits").
  articles: {
    async upsert(id, p) {
      const activiteId = String(p.activiteId || '');
      const nom = String(p.nom ?? '').trim();
      if (!activiteId) throw new SyncError('Activité requise.');
      if (!nom) throw new SyncError('Le nom du produit est requis.');

      const doublon = await prisma.article.findFirst({
        where: {
          activiteId,
          deletedAt: null,
          id: { not: id },
          nom: { equals: nom, mode: 'insensitive' },
        },
      });
      if (doublon) throw new SyncError(`Le produit « ${nom} » existe déjà dans cette activité.`);

      await prisma.$transaction(async (tx) => {
        await tx.article.upsert({
          where: { id },
          create: { id, activiteId, nom },
          update: { nom, deletedAt: null },
        });
        // Le nom est recopié sur chaque session (ventes, crédits et bilans l'utilisent).
        await tx.produit.updateMany({ where: { articleId: id }, data: { nom } });
      });
    },
  },

  // "produits" = SESSIONS d'un article.
  produits: {
    // Création uniquement (pas de modifierProduit côté mobile) : idempotent via l'id.
    // Le numéro de session est attribué ICI (par article), jamais côté mobile, pour éviter
    // les collisions entre deux sessions créées hors ligne sur des appareils différents.
    async upsert(id, p) {
      const existant = await prisma.produit.findUnique({ where: { id } });
      if (existant) return; // rejoué : déjà appliqué, on ne réattribue pas de numéro

      const prixUnitaire = Number(p.prixUnitaire);
      if (!prixUnitaire || prixUnitaire <= 0) throw new SyncError('Prix de vente invalide.');

      await prisma.$transaction(async (tx) => {
        let article;
        if (p.articleId) {
          article = await tx.article.findUnique({ where: { id: String(p.articleId) } });
          if (!article) throw new SyncError('Produit parent introuvable.');
        } else {
          // Anciens téléphones : on retrouve ou on crée le produit à partir de son nom.
          const activiteId = String(p.activiteId || '');
          const nom = String(p.nom ?? '').trim() || 'Produit';
          if (!activiteId) throw new SyncError('Activité requise.');
          article = await tx.article.upsert({
            where: { activiteId_nom: { activiteId, nom } },
            create: { activiteId, nom },
            update: {},
          });
        }

        const dernier = await tx.produit.aggregate({
          where: { articleId: article.id },
          _max: { numeroSession: true },
        });
        const numeroSession = (dernier._max.numeroSession ?? 0) + 1;

        await tx.produit.create({
          data: {
            id,
            activiteId: article.activiteId,
            articleId: article.id,
            numeroSession,
            nom: article.nom,
            quantiteStock: p.quantiteStock ?? 0,
            quantiteInitiale: p.quantiteInitiale ?? 0,
            prixAchatUnitaire: p.prixAchatUnitaire ?? 0,
            totalInvesti: p.totalInvesti ?? 0,
            dateAchat: p.dateAchat ? new Date(p.dateAchat) : new Date(),
            prixUnitaire,
            seuilAlerte: p.seuilAlerte ?? 0,
          },
        });
      });
    },

    // delta > 0 = entrée (réappro), delta < 0 = sortie (perte/casse). Toujours un INCREMENT,
    // jamais un SET absolu, pour rester correct même avec plusieurs ajustements concurrents.
    async stock_adjust(id, p) {
      const delta = Number(p.delta);
      if (!delta) throw new SyncError('Quantité d’ajustement invalide.');

      await prisma.$transaction(async (tx) => {
        const produit = await tx.produit.findUnique({ where: { id } });
        if (!produit) throw new SyncError('Produit introuvable.');
        if (Number(produit.quantiteStock) + delta < 0) {
          throw new SyncError('Stock insuffisant côté serveur pour cet ajustement.');
        }

        const data: Prisma.ProduitUpdateInput = { quantiteStock: { increment: delta } };

        if (delta > 0 && p.prixAchatUnitaire) {
          const prixAchat = Number(p.prixAchatUnitaire);
          await tx.achatProduit.create({
            data: {
              produitId: id,
              quantite: delta,
              prixUnitaire: prixAchat,
              montantTotal: delta * prixAchat,
              motif: p.motif || null,
            },
          });
          data.totalInvesti = { increment: delta * prixAchat };
        }

        await tx.produit.update({ where: { id }, data });
      });
    },
  },

  ventes: {
    // Une vente = vente + (crédit OU mouvement de caisse) + décrément du stock,
    // dans UNE seule transaction. Idempotent via l'id (une vente n'est jamais modifiée).
    async upsert(id, p, userId) {
      const existant = await prisma.vente.findUnique({ where: { id } });
      if (existant) return;

      const quantite = Number(p.quantite);
      const montant = Number(p.montant);
      if (!quantite || quantite <= 0) throw new SyncError('Quantité de vente invalide.');
      if (!montant || montant <= 0) throw new SyncError('Montant de vente invalide.');
      if (!['COMPTANT', 'CREDIT'].includes(p.modePaiement)) {
        throw new SyncError('Mode de paiement invalide.');
      }

      await prisma.$transaction(async (tx) => {
        const produit = await tx.produit.findUnique({ where: { id: p.produitId } });
        if (!produit) throw new SyncError('Produit introuvable.');
        if (Number(produit.quantiteStock) < quantite) {
          throw new SyncError(
            `Stock insuffisant (${produit.quantiteStock} restant, ${quantite} demandé).`
          );
        }

                const client = await tx.client.findUnique({ where: { id: p.clientId } });
        if (!client) throw new SyncError('Client introuvable.');
        if (client.activiteId && client.activiteId !== p.activiteId) {
          throw new SyncError('Ce client appartient à une autre activité.');
        }
        // ---------- Règle de crédit selon l'activité ----------
        if (p.modePaiement === 'CREDIT') {
          const activite = await tx.activite.findUnique({ where: { id: p.activiteId } });

          if (activite && estEssence(activite.nom)) {
            const ouverts = await tx.credit.findMany({
              where: {
                clientId: p.clientId,
                activiteId: p.activiteId,
                statut: 'EN_COURS',
                deletedAt: null,
              },
            });

            if (ouverts.length > 0) {
              const initial = ouverts.reduce((s, c) => s + Number(c.montantInitial), 0);
              const rembourse = ouverts.reduce((s, c) => s + Number(c.montantRembourse), 0);

              if (rembourse < initial * SEUIL_REMBOURSEMENT_ESSENCE) {
                throw new SyncError(
                  `Ce client doit d'abord rembourser au moins 50 % de son crédit ` +
                    `(remboursé : ${rembourse} sur ${initial}).`
                );
              }
            }
          }
        }

        await tx.produit.update({
          where: { id: p.produitId },
          data: { quantiteStock: { decrement: quantite } },
        });

        await tx.vente.create({
          data: {
            id,
            activiteId: p.activiteId,
            clientId: p.clientId,
            produitId: p.produitId,
            saisiParId: userId,
            quantite,
            montant,
            modePaiement: p.modePaiement,
            date: p.date ? new Date(p.date) : new Date(),
          },
        });

        if (p.modePaiement === 'CREDIT') {
          await tx.credit.create({
            data: {
              id, // même id que la vente : la ligne créée hors ligne sur le téléphone n'est pas dupliquée au pull
              clientId: p.clientId,
              activiteId: p.activiteId,
              venteId: id,
              montantInitial: montant,
              montantRestant: montant,
            },
          });
        } else {
          await tx.mouvementCaisse.create({
            data: {
              activiteId: p.activiteId,
              venteId: id,
              saisiParId: userId,
              type: 'ENTREE',
              montant,
              motif: 'Vente',
            },
          });
        }
      });
    },

    // Suppression : stock remis, caisse compensée (comptant), crédit annulé (crédit).
    // Idempotent : rejouer l'opération sur une vente déjà supprimée ne fait rien.
    async delete(id, _p, userId) {
      await prisma.$transaction(async (tx) => {
        const vente = await tx.vente.findUnique({
          where: { id },
          include: { credit: true, mouvementCaisse: true },
        });
        if (!vente || vente.deletedAt) return;

        if (vente.credit && Number(vente.credit.montantRembourse) > 0) {
          throw new SyncError('Suppression refusée : ce crédit a déjà été remboursé en partie.');
        }

        await tx.produit.update({
          where: { id: vente.produitId },
          data: {
            quantiteStock: { increment: Number(vente.quantite) },
            sessionTerminee: false,
            dateFinSession: null,
          },
        });

        if (vente.modePaiement === 'COMPTANT' && vente.mouvementCaisse) {
          await tx.mouvementCaisse.create({
            data: {
              activiteId: vente.activiteId,
              saisiParId: userId,
              type: 'SORTIE',
              montant: vente.montant,
              motif: `Annulation vente ${vente.id}`,
              categorie: 'ANNULATION_VENTE',
            },
          });
        }

        // statut SOLDE + restant 0 : même une requête qui ne filtre pas deletedAt l'ignore.
        if (vente.credit) {
          await tx.credit.update({
            where: { id: vente.credit.id },
            data: { deletedAt: new Date(), statut: 'SOLDE', montantRestant: 0 },
          });
        }

        await tx.vente.update({ where: { id }, data: { deletedAt: new Date() } });

        await tx.auditLog.create({
          data: {
            utilisateurId: userId,
            action: 'SUPPRESSION_VENTE',
            entite: 'Vente',
            entiteId: id,
            details: {
              modePaiement: vente.modePaiement,
              montant: Number(vente.montant),
              quantite: Number(vente.quantite),
            },
          },
        });
      });
    },
  },

  credits: {
    // Remboursement partiel ou total. Jamais de "set" du solde : toujours appliqué au solde
    // ACTUEL en base, donc correct même si plusieurs remboursements arrivent d'affilée.
    async remboursement(creditId, p, userId) {
      const montant = Number(p.montant);
      if (!montant || montant <= 0) throw new SyncError('Montant de remboursement invalide.');

      await prisma.$transaction(async (tx) => {
        const credit = await tx.credit.findUnique({ where: { id: creditId } });
        if (!credit || credit.deletedAt) throw new SyncError('Crédit introuvable.');
        if (credit.statut === 'SOLDE') throw new SyncError('Ce crédit est déjà soldé.');

        const restant = Number(credit.montantRestant);
        const applique = Math.min(montant, restant); // ne jamais dépasser le solde dû
        const nouveauRestant = restant - applique;

        await tx.credit.update({
          where: { id: creditId },
          data: {
            montantRembourse: { increment: applique },
            montantRestant: nouveauRestant,
            statut: nouveauRestant <= 0 ? 'SOLDE' : 'EN_COURS',
            dateSolde: nouveauRestant <= 0 ? new Date() : null,
          },
        });

        await tx.remboursement.create({
          data: { creditId, saisiParId: userId, montant: applique },
        });

        await tx.mouvementCaisse.create({
          data: {
            activiteId: credit.activiteId,
            saisiParId: userId,
            type: 'ENTREE',
            montant: applique,
            motif: 'Remboursement crédit client',
          },
        });
      });
    },
  },

  mouvements_caisse: {
    async upsert(id, p, userId) {
      const existant = await prisma.mouvementCaisse.findUnique({ where: { id } });
      if (existant) return;

      const montant = Number(p.montant);
      if (!montant || montant <= 0) throw new SyncError('Montant invalide.');
      if (!['ENTREE', 'SORTIE'].includes(p.type)) throw new SyncError('Type de mouvement invalide.');
      if (!p.motif || !String(p.motif).trim()) throw new SyncError('Le motif est requis.');

      await prisma.mouvementCaisse.create({
        data: {
          id,
          activiteId: p.activiteId,
          saisiParId: userId,
          type: p.type,
          montant,
          motif: String(p.motif).trim(),
        },
      });
    },
  },

  financements: {
    // Un financement créé = une SORTIE de caisse immédiate (argent avancé au client).
    async upsert(id, p, userId) {
      const existant = await prisma.financement.findUnique({ where: { id } });
      if (existant) return;

      const montant = Number(p.montant);
      if (!montant || montant <= 0) throw new SyncError('Montant invalide.');
      const nom = String(p.nom || '').trim();
      const prenom = String(p.prenom || '').trim();
      if (!nom || !prenom) throw new SyncError('Nom et prénom requis.');

      await prisma.$transaction(async (tx) => {
        const mouvement = await tx.mouvementCaisse.create({
          data: {
            activiteId: p.activiteId,
            saisiParId: userId,
            type: 'SORTIE',
            montant,
            motif: `Financement — ${prenom} ${nom}`,
            categorie: 'FINANCEMENT',
          },
        });
        await tx.financement.create({
          data: {
            id,
            activiteId: p.activiteId,
            nom,
            prenom,
            telephone: p.telephone || null,
            montant,
            montantRestant: montant,
            saisiParId: userId,
            date: p.date ? new Date(p.date) : new Date(),
            mouvementCaisseId: mouvement.id,
          },
        });
      });
    },

    // Remboursement = une ENTREE de caisse (le client rend l'argent avancé).
    async remb_financement(id, p, userId) {
      const montant = Number(p.montant);
      if (!montant || montant <= 0) throw new SyncError('Montant invalide.');

      await prisma.$transaction(async (tx) => {
        const fin = await tx.financement.findUnique({ where: { id } });
        if (!fin) throw new SyncError('Financement introuvable.');
        if (fin.statut === 'PAYE') throw new SyncError('Ce financement est déjà payé.');

        const restant = Number(fin.montantRestant);
        const applique = Math.min(montant, restant);
        const nouveauRestant = restant - applique;

        const mouvement = await tx.mouvementCaisse.create({
          data: {
            activiteId: fin.activiteId,
            saisiParId: userId,
            type: 'ENTREE',
            montant: applique,
            motif: `Remboursement financement — ${fin.prenom} ${fin.nom}`,
            categorie: 'FINANCEMENT',
          },
        });

        await tx.remboursementFinancement.create({
          data: {
            financementId: id,
            saisiParId: userId,
            montant: applique,
            typePaiement: p.typePaiement || 'PARTIEL',
            mouvementCaisseId: mouvement.id,
          },
        });

        await tx.financement.update({
          where: { id },
          data: {
            montantRembourse: { increment: applique },
            montantRestant: nouveauRestant,
            statut: nouveauRestant <= 0 ? 'PAYE' : 'NON_PAYE',
            dateSolde: nouveauRestant <= 0 ? new Date() : null,
          },
        });
      });
    },
  },
};

function messageMetier(e: unknown): string | null {
  if (e instanceof SyncError) return e.message;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return 'Un enregistrement avec ces informations existe déjà.';
  }
  return null;
}

// ---------- PUSH ----------
router.post('/push', async (req, res, next) => {
  try {
    const userId = (req as any).user.id as string;
    const operations: Operation[] = Array.isArray(req.body?.operations)
      ? req.body.operations.slice(0, 100)
      : [];
    console.log('PUSH reçu par CE serveur:', operations.map((o) => `${o.entity}.${o.op}`));

    const results: { opId: string; ok: boolean; message?: string }[] = [];

    for (const o of operations) {
      try {
        const fn = handlers[o.entity]?.[o.op];
        if (!fn) throw new SyncError(`Opération inconnue : ${o.entity}.${o.op}`);
        if (!UUID.test(o.entityId)) throw new SyncError('Identifiant invalide.');

        await fn(o.entityId, o.payload, userId);
        results.push({ opId: o.opId, ok: true });
      } catch (e) {
        console.error('SYNC PUSH ERREUR', o.entity, o.op, e);

        const msg = messageMetier(e);

        if (msg === null) throw e; // erreur technique → 500 → le mobile réessaiera
        results.push({ opId: o.opId, ok: false, message: msg });
      }
    }
    res.json({ results });
  } catch (e) {
    next(e);
  }
});

async function activiteIdsAccessibles(user: { id: string; roleGlobal?: string }) {
  // Admin / propriétaire : accès à toutes les activités, sans liaison à saisir.
  if (String(user.roleGlobal ?? '').toUpperCase().includes('ADMIN')) {
    const toutes = await prisma.activite.findMany({ select: { id: true } });
    return toutes.map((a) => a.id);
  }
  // Autres rôles : activités affectées, sinon repli sur toutes (cas d'une petite équipe
  // où personne n'a encore été affecté), pour ne jamais rester avec un écran vide.
  const acces = await prisma.utilisateurActivite.findMany({
    where: { utilisateurId: user.id },
    select: { activiteId: true },
  });
  if (acces.length > 0) return acces.map((a) => a.activiteId);

  const toutes = await prisma.activite.findMany({ select: { id: true } });
  return toutes.map((a) => a.id);
}

// ---------- PULL ----------
router.get('/pull', async (req, res, next) => {
  try {
    const serverTime = new Date();
    const sinceRaw = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
    const since = sinceRaw && !isNaN(sinceRaw.getTime()) ? sinceRaw : null;
    const where = since ? { updatedAt: { gt: since } } : { deletedAt: null };

    // Activités auxquelles l'utilisateur a accès : tout le reste (produits, ventes…) est
    // scopé à ces activités pour qu'un utilisateur ne récupère jamais les données d'une
    // activité qui n'est pas la sienne.
    const activiteIds = await activiteIdsAccessibles((req as any).user);
    const whereActivite = since
      ? { updatedAt: { gt: since }, activiteId: { in: activiteIds } }
      : { deletedAt: null, activiteId: { in: activiteIds } };

    const [clients, activites, articles, produits, ventes, credits, mouvementsCaisse, financements] =
      await Promise.all([
        prisma.client.findMany({ where: whereActivite, orderBy: { updatedAt: 'asc' } }),
                prisma.activite.findMany({
          where: since
            ? { updatedAt: { gt: since }, id: { in: activiteIds } }
            : { id: { in: activiteIds } },
          orderBy: { updatedAt: 'asc' },
        }),
        prisma.article.findMany({ where: whereActivite, orderBy: { updatedAt: 'asc' } }),
        prisma.produit.findMany({ where: whereActivite, orderBy: { updatedAt: 'asc' } }),
        prisma.vente.findMany({ where: whereActivite, orderBy: { updatedAt: 'asc' } }),
        prisma.credit.findMany({
          where: since
            ? { updatedAt: { gt: since }, activiteId: { in: activiteIds } }
            : { deletedAt: null, activiteId: { in: activiteIds } },
          orderBy: { updatedAt: 'asc' },
        }),
        prisma.mouvementCaisse.findMany({ where: whereActivite, orderBy: { updatedAt: 'asc' } }),
        prisma.financement.findMany({ where: whereActivite, orderBy: { updatedAt: 'asc' } }),
      ]);

    res.json({
      serverTime: new Date(serverTime.getTime() - 5000).toISOString(),
      clients,
      activites,
      articles,
      produits,
      ventes,
      credits,
      mouvements_caisse: mouvementsCaisse,
      financements,
    });
  } catch (e) {
    next(e);
  }
});

export default router;