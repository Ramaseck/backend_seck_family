import { prisma } from "../../lib/prisma";
import { AppError } from "../../middlewares/errorHandler";

interface CreerVenteInput {
  activiteId: string;
  clientId: string;
  produitId: string;
  saisiParId: string;
  quantite: number;
  modePaiement: "COMPTANT" | "CREDIT";
}

// Essence : un seul crédit ouvert par client, sauf si 50 % ont été remboursés.
const SEUIL_REMBOURSEMENT_ESSENCE = 0.5;

function estEssence(nom: string) {
  return nom
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .includes("essence");
}

/**
 * Crée une vente.
 * Le montant est calculé côté serveur : prixUnitaire × quantite.
 */
export async function creerVente(input: CreerVenteInput) {
  const { activiteId, clientId, produitId, saisiParId, quantite, modePaiement } = input;

  return prisma.$transaction(async (tx) => {
    // ---------- Produit ----------
    const produit = await tx.produit.findUnique({ where: { id: produitId } });
    if (!produit) throw new AppError("Produit introuvable.", 404);

    if (produit.activiteId !== activiteId) {
      throw new AppError("Ce produit n'appartient pas à cette activité.", 400);
    }
    if (produit.sessionTerminee) {
      throw new AppError(`La session du produit "${produit.nom}" est déjà terminée.`, 400);
    }

    // ---------- Quantité / stock ----------
    const stockDisponible = Number(produit.quantiteStock);
    const quantiteDemandee = Number(quantite);

    if (!Number.isFinite(quantiteDemandee)) throw new AppError("La quantité est invalide.", 400);
    if (quantiteDemandee <= 0) throw new AppError("La quantité doit être supérieure à 0.", 400);

    if (stockDisponible <= 0) {
      throw new AppError(`Stock épuisé. Le produit "${produit.nom}" n'est plus disponible à la vente.`, 400);
    }
    if (quantiteDemandee > stockDisponible) {
      throw new AppError(
        `Stock insuffisant pour "${produit.nom}". ` +
          `Stock disponible : ${stockDisponible}. Quantité demandée : ${quantiteDemandee}.`,
        400
      );
    }

    // ---------- Prix / montant ----------
    const prixVenteUnitaire = Number(produit.prixUnitaire);
    if (!Number.isFinite(prixVenteUnitaire) || prixVenteUnitaire <= 0) {
      throw new AppError(`Le produit "${produit.nom}" n'a pas de prix de vente valide.`, 400);
    }

    const montant = prixVenteUnitaire * quantiteDemandee;
    if (!Number.isFinite(montant) || montant <= 0) {
      throw new AppError("Le montant calculé de la vente est invalide.", 400);
    }

    const nouveauStock = stockDisponible - quantiteDemandee;
    if (nouveauStock < 0) {
      throw new AppError("La vente ne peut pas être effectuée : le stock ne peut pas être négatif.", 400);
    }

    // ---------- Contrôle du crédit ----------
    if (modePaiement === "CREDIT") {
      const activite = await tx.activite.findUnique({ where: { id: activiteId } });

      if (activite && estEssence(activite.nom)) {
        const ouverts = await tx.credit.findMany({
          where: { clientId, activiteId, statut: "EN_COURS", deletedAt: null },
        });

        if (ouverts.length > 0) {
          const initial = ouverts.reduce((s, c) => s + Number(c.montantInitial), 0);
          const rembourse = ouverts.reduce((s, c) => s + Number(c.montantRembourse), 0);

          if (rembourse < initial * SEUIL_REMBOURSEMENT_ESSENCE) {
            throw new AppError(
              `Ce client doit d'abord rembourser au moins 50 % de son crédit ` +
                `(remboursé : ${rembourse} sur ${initial}).`,
              409
            );
          }
        }
      }
      // Bateau Vente Poisson et autres activités : pas de limite.
    }

    // ---------- Création de la vente ----------
    const vente = await tx.vente.create({
      data: {
        activiteId,
        clientId,
        produitId,
        saisiParId,
        quantite: quantiteDemandee,
        montant,
        modePaiement,
      },
    });

    await tx.produit.update({
      where: { id: produitId },
      data: {
        quantiteStock: nouveauStock,
        sessionTerminee: nouveauStock === 0,
        dateFinSession: nouveauStock === 0 ? new Date() : null,
      },
    });

    if (modePaiement === "COMPTANT") {
      await tx.mouvementCaisse.create({
        data: {
          activiteId,
          venteId: vente.id,
          saisiParId,
          type: "ENTREE",
          montant,
          motif: "Vente comptant",
        },
      });
    } else {
      await tx.credit.create({
        data: {
          clientId,
          activiteId,
          venteId: vente.id,
          montantInitial: montant,
          montantRembourse: 0,
          montantRestant: montant,
          statut: "EN_COURS",
        },
      });
    }

    await tx.auditLog.create({
      data: {
        utilisateurId: saisiParId,
        action: "CREATION_VENTE",
        entite: "Vente",
        entiteId: vente.id,
        details: {
          modePaiement,
          prixVenteUnitaire,
          montant,
          quantite: quantiteDemandee,
          stockAvant: stockDisponible,
          stockApres: nouveauStock,
        },
      },
    });

    return vente;
  });
}

/**
 * Supprime (annule) une vente :
 *  - le stock du produit est remis ;
 *  - comptant : une SORTIE de caisse du même montant compense l'ENTREE d'origine ;
 *  - crédit   : le crédit est supprimé (refusé s'il a déjà été remboursé en partie).
 * La vente est conservée en base (deletedAt) pour l'historique et la synchronisation.
 */
export async function supprimerVente(id: string, utilisateurId: string) {
  return prisma.$transaction(async (tx) => {
    const vente = await tx.vente.findUnique({
      where: { id },
      include: { credit: true, mouvementCaisse: true },
    });

    if (!vente) throw new AppError("Vente introuvable.", 404);
    if (vente.deletedAt) return vente; // déjà supprimée : on répond OK (appel rejoué par la synchro)

    if (vente.credit && Number(vente.credit.montantRembourse) > 0) {
      throw new AppError(
        "Suppression impossible : ce crédit a déjà été remboursé en partie.",
        400
      );
    }

    // ---------- Stock ----------
    const produit = await tx.produit.findUnique({ where: { id: vente.produitId } });
    if (!produit) throw new AppError("Produit introuvable.", 404);

    const stockApres = Number(produit.quantiteStock) + Number(vente.quantite);

    await tx.produit.update({
      where: { id: vente.produitId },
      data: {
        quantiteStock: stockApres,
        sessionTerminee: false,
        dateFinSession: null,
      },
    });

    // ---------- Caisse (comptant) ----------
    if (vente.modePaiement === "COMPTANT" && vente.mouvementCaisse) {
      await tx.mouvementCaisse.create({
        data: {
          activiteId: vente.activiteId,
          saisiParId: utilisateurId,
          type: "SORTIE",
          montant: vente.montant,
          motif: `Annulation vente ${vente.id}`,
          categorie: "ANNULATION_VENTE",
        },
      });
    }

    // ---------- Crédit ----------
    // statut SOLDE + restant 0 : même une requête qui ne filtre pas deletedAt l'ignore.
    if (vente.credit) {
      await tx.credit.update({
        where: { id: vente.credit.id },
        data: { deletedAt: new Date(), statut: "SOLDE", montantRestant: 0 },
      });
    }

    // ---------- Vente ----------
    const supprimee = await tx.vente.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        utilisateurId: utilisateurId,
        action: "SUPPRESSION_VENTE",
        entite: "Vente",
        entiteId: id,
        details: {
          modePaiement: vente.modePaiement,
          montant: Number(vente.montant),
          quantite: Number(vente.quantite),
          stockApres,
        },
      },
    });

    return supprimee;
  });
}

/**
 * Liste les ventes d'une activité (hors ventes supprimées).
 */
export function listerVentes(activiteId: string, clientId?: string) {
  return prisma.vente.findMany({
    where: {
      activiteId,
      deletedAt: null,
      ...(clientId ? { clientId } : {}),
    },
    orderBy: { date: "desc" },
    include: { client: true, produit: true, activite: true },
  });
}

/**
 * Récupère une vente.
 */
export function obtenirVente(id: string) {
  return prisma.vente.findUniqueOrThrow({
    where: { id },
    include: { client: true, produit: true, credit: true, mouvementCaisse: true },
  });
}