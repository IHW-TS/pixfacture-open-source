"use client";

const einvoicingMod = require("../../../figma/app/pages/app/EinvoicingPages");
const cashMod = require("../../../figma/app/pages/app/CashPage");
const portfolioMod = require("../../../figma/app/pages/app/PortfolioPage");
const recurringMod = require("../../../figma/app/pages/app/RecurringPage");
const tasksMod = require("../../../figma/app/pages/app/TasksPage");
const notificationsMod = require("../../../figma/app/pages/app/NotificationsPage");
const automationsMod = require("../../../figma/app/pages/app/AutomationsPage");
const campaignsMod = require("../../../figma/app/pages/app/CampaignsPage");
const outboxMod = require("../../../figma/app/pages/app/OutboxPage");
const schedulerMod = require("../../../figma/app/pages/app/SchedulerPage");

export const PaymentsPage = cashMod.CashPage;
export const PurchasesPage = einvoicingMod.InboxPage;
export const PurchaseDetailPage = einvoicingMod.InboxPage;
export const CashPage = cashMod.CashPage;
export const PortfolioPage = portfolioMod.PortfolioPage;
export const RecurringPage = recurringMod.RecurringPage;
export const TasksPage = tasksMod.TasksPage;
export const NotificationsPage = notificationsMod.NotificationsPage;
export const AutomationsPage = automationsMod.AutomationsPage;
export const CampaignsPage = campaignsMod.CampaignsPage;
export const OutboxPage = outboxMod.OutboxPage;
export const SchedulerPage = schedulerMod.SchedulerPage;
