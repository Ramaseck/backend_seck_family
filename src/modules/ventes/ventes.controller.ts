import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { creerVente, listerVentes, supprimerVente } from "./ventes.service";

// Le montant n'est PAS reçu ici : il est calculé côté backend
// à partir de produit.prixUnitaire × quantite.
const creerVenteSchema = z.object({
  activiteId: z.string().uuid(),
  clientId: z.string().uuid(),
  produitId: z.string().uuid(),
  quantite: z.number().positive(),
  modePaiement: z.enum(["COMPTANT", "CREDIT"]),
});

export async function creer(req: Request, res: Response, next: NextFunction) {
  try {
    const body = creerVenteSchema.parse(req.body);
    const vente = await creerVente({ ...body, saisiParId: req.user!.id });
    res.status(201).json(vente);
  } catch (err) {
    next(err);
  }
}

export async function lister(req: Request, res: Response, next: NextFunction) {
  try {
    const activiteId = req.query.activiteId as string;
    const ventes = await listerVentes(activiteId);
    res.json(ventes);
  } catch (err) {
    next(err);
  }
}

export async function supprimer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = z.string().uuid().parse(req.params.id);
    await supprimerVente(id, req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}