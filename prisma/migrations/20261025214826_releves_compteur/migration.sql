-- CreateTable
CREATE TABLE "releves_compteur" (
    "id" TEXT NOT NULL,
    "activiteId" TEXT NOT NULL,
    "produitId" TEXT NOT NULL,
    "pompe" TEXT NOT NULL DEFAULT 'Pompe 1',
    "indexDebut" DECIMAL(65,30) NOT NULL,
    "indexFin" DECIMAL(65,30),
    "dateDebut" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateFin" TIMESTAMP(3),
    "saisiParId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "releves_compteur_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "releves_compteur_updatedAt_idx" ON "releves_compteur"("updatedAt");

-- CreateIndex
CREATE INDEX "releves_compteur_activiteId_dateDebut_idx" ON "releves_compteur"("activiteId", "dateDebut");

-- AddForeignKey
ALTER TABLE "releves_compteur" ADD CONSTRAINT "releves_compteur_activiteId_fkey" FOREIGN KEY ("activiteId") REFERENCES "activites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releves_compteur" ADD CONSTRAINT "releves_compteur_produitId_fkey" FOREIGN KEY ("produitId") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
