"use client";

const compareMod = require("../../../../figma-compare-srcs/pages/app/QuotesPage");
const realMod = require("../../../figma/app/pages/app/QuotesPage");

export const QuotesListPage = compareMod.QuotesListPage;
export const QuoteDetailPage = realMod.QuoteDetailPage;
export const QuoteNewPage = realMod.QuoteNewPage;
