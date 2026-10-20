import { Router } from "express";
import { requireAuth } from "../../middlewares/auth";
import { creer, lister,supprimer } from "./ventes.controller";

const router = Router();

router.post("/", requireAuth, creer);
router.get("/", requireAuth, lister);
router.delete("/:id", supprimer);

export default router;
