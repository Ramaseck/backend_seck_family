"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.creer = creer;
exports.lister = lister;
exports.supprimer = supprimer;
const zod_1 = require("zod");
const ventes_service_1 = require("./ventes.service");
// Le montant n'est PAS reçu ici : il est calculé côté backend
// à partir de produit.prixUnitaire × quantite.
const creerVenteSchema = zod_1.z.object({
    activiteId: zod_1.z.string().uuid(),
    clientId: zod_1.z.string().uuid(),
    produitId: zod_1.z.string().uuid(),
    quantite: zod_1.z.number().positive(),
    modePaiement: zod_1.z.enum(["COMPTANT", "CREDIT"]),
});
async function creer(req, res, next) {
    try {
        const body = creerVenteSchema.parse(req.body);
        const vente = await (0, ventes_service_1.creerVente)({ ...body, saisiParId: req.user.id });
        res.status(201).json(vente);
    }
    catch (err) {
        next(err);
    }
}
async function lister(req, res, next) {
    try {
        const activiteId = req.query.activiteId;
        const ventes = await (0, ventes_service_1.listerVentes)(activiteId);
        res.json(ventes);
    }
    catch (err) {
        next(err);
    }
}
async function supprimer(req, res, next) {
    try {
        const id = zod_1.z.string().uuid().parse(req.params.id);
        await (0, ventes_service_1.supprimerVente)(id, req.user.id);
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=ventes.controller.js.map