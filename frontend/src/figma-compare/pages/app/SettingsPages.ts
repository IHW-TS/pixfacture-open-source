"use client";

const compareMod = require("../../../../figma-compare-srcs/pages/app/SettingsPages");
const realMod = require("../../../figma/app/pages/app/SettingsPages");

export const SettingsIndexPage = compareMod.SettingsIndexPage;
export const SettingsCompanyPage = realMod.SettingsCompanyPage;
export const SettingsBillingPage = realMod.SettingsBillingPage;
export const SettingsBrandingPage = compareMod.SettingsBrandingPage;
export const SettingsSecurityPage = realMod.SettingsSecurityPage;
export const SettingsExportPage = realMod.SettingsExportPage;
export const SettingsWebhooksPage = realMod.SettingsWebhooksPage;
export const SettingsDunningPage = realMod.SettingsDunningPage;
export const SettingsMigrationPage = realMod.SettingsMigrationPage;
export const SettingsGenericPage = realMod.SettingsGenericPage;
export const SettingsPlatformsPage = realMod.SettingsPlatformsPage;
export const SettingsPortalsPage = realMod.SettingsPortalsPage;
export const SettingsSandboxPage = realMod.SettingsSandboxPage;
export const SettingsAttachmentsPage = realMod.SettingsAttachmentsPage;
