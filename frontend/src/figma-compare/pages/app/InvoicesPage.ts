"use client";

const compareMod = require("../../../../figma-compare-srcs/pages/app/InvoicesPage");
const realMod = require("../../../figma/app/pages/app/InvoicesPage");

export const InvoicesListPage = compareMod.InvoicesListPage;
export const InvoiceDetailPage = realMod.InvoiceDetailPage;
export const InvoiceNewPage = realMod.InvoiceNewPage;
