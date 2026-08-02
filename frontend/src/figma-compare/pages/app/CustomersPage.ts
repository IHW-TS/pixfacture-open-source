"use client";

const compareMod = require("../../../../figma-compare-srcs/pages/app/CustomersPage");
const realMod = require("../../../figma/app/pages/app/CustomersPage");

// On garde la liste dans le style de présentation d'origine,
// mais on bascule les formulaires / détails vers les vraies pages applicatives.
export const CustomersListPage = compareMod.CustomersListPage;
export const CustomerDetailPage = realMod.CustomerDetailPage;
export const CustomerNewPage = realMod.CustomerNewPage;
