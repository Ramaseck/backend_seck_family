/*
  Warnings:

  - A unique constraint covering the columns `[activiteId,nom]` on the table `clients` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[activiteId,contact]` on the table `clients` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "clients_contact_key";

-- DropIndex
DROP INDEX "clients_nom_key";

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "activiteId" TEXT;

-- CreateIndex
CREATE INDEX "clients_activiteId_idx" ON "clients"("activiteId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_activiteId_nom_key" ON "clients"("activiteId", "nom");

-- CreateIndex
CREATE UNIQUE INDEX "clients_activiteId_contact_key" ON "clients"("activiteId", "contact");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_activiteId_fkey" FOREIGN KEY ("activiteId") REFERENCES "activites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Reprise des données : séparation des clients par activité
CREATE TEMP TABLE client_activites AS
SELECT u."clientId", u."activiteId",
       ROW_NUMBER() OVER (PARTITION BY u."clientId" ORDER BY a."createdAt", a."id") AS rang,
       gen_random_uuid()::text AS "nouvelId"
FROM (
  SELECT "clientId", "activiteId" FROM "ventes"
  UNION
  SELECT "clientId", "activiteId" FROM "credits"
) u
JOIN "activites" a ON a."id" = u."activiteId";

-- Une copie du client pour chaque activité supplémentaire où il a acheté
INSERT INTO "clients" ("id", "nom", "contact", "createdAt", "updatedAt", "deletedAt", "activiteId")
SELECT ca."nouvelId", c."nom", c."contact", c."createdAt", now(), c."deletedAt", ca."activiteId"
FROM client_activites ca
JOIN "clients" c ON c."id" = ca."clientId"
WHERE ca.rang > 1;

-- Les ventes et crédits de ces activités suivent la copie
UPDATE "ventes" v SET "clientId" = ca."nouvelId", "updatedAt" = now()
FROM client_activites ca
WHERE ca."clientId" = v."clientId" AND ca."activiteId" = v."activiteId" AND ca.rang > 1;

UPDATE "credits" cr SET "clientId" = ca."nouvelId", "updatedAt" = now()
FROM client_activites ca
WHERE ca."clientId" = cr."clientId" AND ca."activiteId" = cr."activiteId" AND ca.rang > 1;

-- Le client d'origine reste dans sa première activité
UPDATE "clients" c SET "activiteId" = ca."activiteId", "updatedAt" = now()
FROM client_activites ca
WHERE ca."clientId" = c."id" AND ca.rang = 1;

-- Clients sans aucune vente : rattachés à la première activité
UPDATE "clients"
SET "activiteId" = (SELECT "id" FROM "activites" ORDER BY "createdAt", "id" LIMIT 1),
    "updatedAt" = now()
WHERE "activiteId" IS NULL;

DROP TABLE client_activites;