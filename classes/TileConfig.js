import { MonksActiveTiles, i18n, log, debug, setting, patchFunc } from "../monks-active-tiles.js";
export class MATT_TileConfig extends foundry.applications.sheets.TileConfig {
    static DEFAULT_OPTIONS = {
        actions: {

        }
    }

    static get PARTS() {
        return foundry.utils.mergeObject(super.PARTS, {
            activetile: { template: "modules/monks-active-tiles/templates/tile-config.html" }
        });
    }

    static get TABS() {
        const tabs = foundry.utils.deepClone(super.TABS);
        tabs.sheet.tabs.push({ id: "activetile", icon: "fa-solid fa-running" });
        tabs.activetile = {
            tabs: [
                { id: "setup", icon: "fa-solid fa-cog" },
                { id: "actions", icon: "fa-solid fa-running" },
                { id: "images", icon: "fa-solid fa-image" }
            ],
            initial: "setup",
            labelPrefix: "MonksActiveTiles.tabs"
        };
        return tabs;
    }

    async _preparePartContext(partId, context, options) {
        context = await super._preparePartContext(partId, context, options);
        if (partId in context.tabs) context.tab = context.tabs[partId];
        return context;
    }
}