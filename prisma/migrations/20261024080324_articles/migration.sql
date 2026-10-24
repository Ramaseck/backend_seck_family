/*
  Warnings:

  - A unique constraint covering the columns `[articleId,numeroSession]` on the table `produits` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "produits_activiteId_numeroSession_key";

-- AlterTable
ALTER TABLE "produits" ADD COLUMN     "articleId" TEXT;

-- CreateTable
CREATE TABLE "articles" (
    "id" TEXT NOT NULL,
    "activiteId" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "articles_updatedAt_idx" ON "articles"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "articles_activiteId_nom_key" ON "articles"("activiteId", "nom");

-- CreateIndex
CREATE INDEX "produits_activiteId_idx" ON "produits"("activiteId");

-- CreateIndex
CREATE UNIQUE INDEX "produits_articleId_numeroSession_key" ON "produits"("articleId", "numeroSession");

-- AddForeignKey
ALTER TABLE "produits" ADD CONSTRAINT "produits_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_activiteId_fkey" FOREIGN KEY ("activiteId") REFERENCES "activites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reprise des données : un produit par (activité, nom), toutes les sessions rattachées
INSERT INTO "articles" ("id", "activiteId", "nom", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "activiteId",
       COALESCE(NULLIF(TRIM("nom"), ''), 'Produit'),
       MIN("createdAt"), now()
FROM "produits"
GROUP BY "activiteId", COALESCE(NULLIF(TRIM("nom"), ''), 'Produit');

UPDATE "produits" p
SET "articleId" = a."id", "nom" = a."nom", "updatedAt" = now()
FROM "articles" a
WHERE a."activiteId" = p."activiteId"
  AND a."nom" = COALESCE(NULLIF(TRIM(p."nom"), ''), 'Produit');