import { MonksActiveTiles, log, error, setting, i18n, makeid } from '../monks-active-tiles.js';
import { ActionConfig } from "../apps/action-config.js";
import { TileHistory } from './tile-history.js';
import { TileVariables } from './tile-variables.js';
import { TileTemplates } from "./tile-templates.js";

export function patchTileConfig() {
    const FoundryTileConfig = foundry.applications.sheets.TileConfig;
    const DefaultTileConfig = Object.values(CONFIG.Tile.sheetClasses.base).find((d) => d.default).cls;
    const TileConfigClass = DefaultTileConfig?.prototype instanceof FoundryTileConfig ? DefaultTileConfig : FoundryTileConfig;

    if (TileConfigClass.HAS_MATT_PATCH) return;
    TileConfigClass.HAS_MATT_PATCH = true;

    // Add Actions
    TileConfigClass.DEFAULT_OPTIONS.actions = foundry.utils.mergeObject(TileConfigClass.DEFAULT_OPTIONS.actions || {}, {
        viewHistory: function() { new TileHistory({ document: this.document }).render(true); },
        viewVariables: function() { new TileVariables({ document: this.document }).render(true); },
        createAction: _createAction,
        editAction: _editAction,
        deleteAction: _deleteAction,
        stopSound: _stopSound,
        browseImages: _browseImages,
        browseFolders: _browseFolders,
        deleteImage: _removeImage,
        saveTemplate: _saveTemplate,
    });

    // Add Tab
    const tabs = TileConfigClass.TABS;
    if (tabs.sheet) {
        if (!tabs.sheet.tabs.some(t => t.id === "activetile")) {
            tabs.sheet.tabs.push({ id: "activetile", icon: "fa-solid fa-running" });
        }
    }
    tabs.activetile = {
        tabs: [
            { id: "setup", icon: "fa-solid fa-cog" },
            { id: "actions", icon: "fa-solid fa-running" },
            { id: "images", icon: "fa-solid fa-image" }
        ],
        initial: "setup",
        labelPrefix: "MonksActiveTiles.tabs"
    };

    // Add Part
    const footerPart = TileConfigClass.PARTS.footer;
    delete TileConfigClass.PARTS.footer;
    TileConfigClass.PARTS.activetile = {
        template: "modules/monks-active-tiles/templates/active-tile-config.hbs",
        templates: [
            "modules/monks-active-tiles/templates/action-partial.hbs",
            "modules/monks-active-tiles/templates/image-partial.hbs"
        ]
    };
    if (footerPart) TileConfigClass.PARTS.footer = footerPart;

    const proto = TileConfigClass.prototype;

    // Constructor Logic via _prepareContext or just one-time init
    const originalPrepareContext = proto._prepareContext;
    proto._prepareContext = async function (options) {
        if (foundry.utils.getProperty(this.document, "flags.monks-active-tiles") == undefined) {
            await this.document.update({
                "flags.monks-active-tiles": {
                    active: true,
                    trigger: setting('default-trigger'),
                    vision: true,
                    chance: 100,
                    restriction: setting('default-restricted'),
                    controlled: setting('default-controlled'),
                    actions: []
                }
            }, { render: false });
        }

        const context = await originalPrepareContext.call(this, options);
        context.tabs = this._prepareTabs("sheet");

        context.buttons.unshift({
            type: "button",
            icon: "fas fa-save",
            label: i18n("MonksActiveTiles.SaveAsTemplate"),
            action: "saveTemplate",
            cssClass: "small-button"
        });
        return context;
    };

    const originalPreparePartContext = proto._preparePartContext;
    proto._preparePartContext = async function (partId, context, options) {
        context = await originalPreparePartContext.call(this, partId, context, options);
        if (partId === "activetile") {
            context.triggerValues = this.document.getFlag("monks-active-tiles", "trigger");
            context.triggerValues = context.triggerValues instanceof Array ? context.triggerValues : [context.triggerValues];
            if (context.triggerValues.includes("both")) {
                context.triggerValues.push("enter", "exit");
                context.triggerValues.findSplice(t => t == "both");
            }
            if (context.triggerValues.includes("hover")) {
                context.triggerValues.push("hoverin", "hoverout");
                context.triggerValues.findSplice(t => t == "hover");
            }

            context.triggerNames = context.triggerValues.map(t => {
                return Object.keys(MonksActiveTiles.triggerModes).includes(t) ? { id: t, name: MonksActiveTiles.triggerModes[t] } : null;
            }).filter(t => !!t);

            context.triggers = Object.entries(MonksActiveTiles.triggerModes).map(([k, v]) => {
                return {
                    id: k,
                    name: v,
                    selected: context.triggerValues.includes(k)
                }
            });

            context.preventPaused = setting("prevent-when-paused");
            let fileindex = this.document.getFlag("monks-active-tiles", "fileindex");
            context.index = (fileindex != undefined ? fileindex + 1 : '');

            context = foundry.utils.mergeObject({ 'data.flags.monks-active-tiles.minrequired': 0 }, context);

            context.triggerModes = MonksActiveTiles.triggerModes;
            context.triggerRestriction = { 'all': i18n("MonksActiveTiles.restrict.all"), 'player': i18n("MonksActiveTiles.restrict.player"), 'gm': i18n("MonksActiveTiles.restrict.gm") };
            context.triggerControlled = { 'all': i18n("MonksActiveTiles.control.all"), 'player': i18n("MonksActiveTiles.control.player"), 'gm': i18n("MonksActiveTiles.control.gm") };

            const actionsList = this.document.getFlag("monks-active-tiles", "actions") || [];
            context.actions = await Promise.all(actionsList
                .map(async (a) => {
                    if (a) {
                        let trigger = MonksActiveTiles.triggerActions[a.action];
                        let content = (trigger == undefined ? 'Unknown' : i18n(trigger.name));
                        if (trigger?.content) {
                            try {
                                content = await trigger.content(trigger, a, actionsList);
                            } catch (e) {
                                error(e);
                            }
                        }

                        let result = {
                            id: a.id,
                            action: a.action,
                            data: a.data,
                            content: content,
                            tooltip: content.replace(/<[^>]*>/g, ""),
                            disabled: trigger?.visible === false
                        }

                        if (a.action == "activate" && a.data?.activate == "deactivate" && (a.data?.entity?.id == this.document.id || a.data?.entity == ""))
                            result.deactivated = "on";
                        if (a.action == "anchor")
                            result.deactivated = "off";

                        return result;
                    }
                }).filter(a => !!a));

            if (setting("show-landing")) {
                let landings = [];
                let currentLanding = 0;
                for (let a of context.actions) {
                    if (a.action == "anchor") {
                        if (a.data.stop) {
                            landings = [];
                        }

                        landings.push(++currentLanding);
                        a.marker = currentLanding;
                        a.landingStop = a.data.stop;
                    }
                    a.landings = foundry.utils.duplicate(landings);
                }
            }

            let disabled = false;
            for (let a of context.actions) {
                if (a.deactivated == "off")
                    disabled = false;
                if (disabled)
                    a.disabled = true;
                if (a.deactivated == "on")
                    disabled = true;
            }

            context.sounds = Object.entries(this.document.soundeffect || {}).filter(([k, v]) => !!v.src).map(([k, v]) => {
                let filename = v.src.split('\\').pop().split('/').pop();
                return {
                    id: k,
                    name: filename
                };
            });

            let index = this.document.getFlag('monks-active-tiles', 'fileindex') || 0;
            context.images = (this.document.getFlag('monks-active-tiles', 'files') || []).map((f, idx) => {
                f.selected = (index == idx);
                return f;
            });

            context.subtabs = this._prepareTabs("activetile");
            context.tab = context.tabs[partId];
        }
        return context;
    };

    const originalClose = proto.close;
    proto.close = async function (options = {}) {
        let result = await originalClose.call(this, options);
        if (this.actionconfig && this.actionconfig.rendered)
            this.actionconfig.close();
        return result;
    };

    const originalOnRender = proto._onRender;
    proto._onRender = async function (context, options) {
        await originalOnRender.call(this, context, options);

        if (!this.element.querySelector('[data-tab="activetile"]')) return;

        $('.small-button', this.element).each(function () {
            $(this).attr("data-tooltip", $("span", this).html());
            $("span", this).remove();
        });

        // Initialize helper methods if not already present (needed for the callbacks)
        if (!this._getContextOptions) this._getContextOptions = _getContextOptions;
        if (!this.cloneAction) this.cloneAction = _cloneAction;
        if (!this.deleteAction) this.deleteAction = _deleteActionMethod;
        if (!this.removeTrigger) this.removeTrigger = _removeTrigger;
        if (!this.selectTrigger) this.selectTrigger = _selectTrigger;
        if (!this.selectImage) this.selectImage = _selectImage;
        if (!this.addFile) this.addFile = _addFile;
        if (!this.addFolder) this.addFolder = _addFolder;
        if (!this.addImageEntry) this.addImageEntry = _addImageEntry;
        if (!this._onDragStart) this._onDragStart = _onDragStart;
        if (!this._onDrop) this._onDrop = _onDrop;

        const contextOptions = this._getContextOptions();
        Hooks.call(`getActiveTileConfigContext`, this.element, contextOptions);
        new foundry.applications.ux.ContextMenu(this.element, ".action-list .action", contextOptions, { fixed: true, jQuery: false });

        $('.record-history', this.element).click(_checkRecordHistory.bind(this));
        $('.per-token', this.element).click(_checkPerToken.bind(this));

        $('.multiple-dropdown-select', this.element).click((event) => {
            $('.multiple-dropdown-select .dropdown-list', this.element).toggleClass('open');
            event.preventDefault();
            event.stopPropagation();
        });
        $(this.element).click(() => { $('.multiple-dropdown-select .dropdown-list', this.element).removeClass('open'); });
        $('.multiple-dropdown-select .remove-option', this.element).on("click", this.removeTrigger.bind(this));
        $('.multiple-dropdown-select .multiple-dropdown-item', this.element).on("click", this.selectTrigger.bind(this));

        $('.image-list .image', this.element).on("dblclick", this.selectImage.bind(this));

        $('.actions-group header', this.element).on("click", (event) => _createAction.call(this, event, event.currentTarget));

        $('.action-list .action', this.element).hover(_onActionHoverIn.bind(this), _onActionHoverOut.bind(this));

        new foundry.applications.ux.DragDrop.implementation({
            dragSelector: ".action-list .action .name",
            dropSelector: ".actions-group",
            permissions: {
                dragstart: () => true,
                drop: () => true
            },
            callbacks: {
                dragstart: _onDragStart.bind(this),
                drop: _onDrop.bind(this)
            }
        }).bind(this.element);

        new foundry.applications.ux.DragDrop.implementation({
            dragSelector: ".image-list .image .name",
            dropSelector: ".images-group",
            permissions: {
                dragstart: () => true,
                drop: () => true
            },
            callbacks: {
                dragstart: _onDragStart.bind(this),
                drop: _onDrop.bind(this)
            }
        }).bind(this.element);
    };

    const originalProcessFormData = proto._processFormData;
    proto._processFormData = function (event, form, formData) {
        if (this.element.querySelector('[data-tab="activetile"]')) {
            formData.object["flags.monks-active-tiles.actions"] = (this.document.getFlag("monks-active-tiles", "actions") || []);
            formData.object["flags.monks-active-tiles.files"] = (this.document.getFlag("monks-active-tiles", "files") || []);

            if (formData.object["flags.monks-active-tiles.fileindex"] != '')
                formData.object["flags.monks-active-tiles.fileindex"] = formData.object["flags.monks-active-tiles.fileindex"] - 1;

            if (typeof formData.object["flags.monks-active-tiles.trigger"] == "string")
                formData.object["flags.monks-active-tiles.trigger"] = formData.object["flags.monks-active-tiles.trigger"].split(",");
        }
        return originalProcessFormData.call(this, event, form, formData);
    };

    const originalProcessSubmitData = proto._processSubmitData;
    proto._processSubmitData = async function (event, form, submitData, options = {}) {
        if (this.element.querySelector('[data-tab="activetile"]')) {
            this.document._images = await MonksActiveTiles.getTileFiles(foundry.utils.getProperty(submitData, "flags.monks-active-tiles.files") || foundry.utils.getProperty(this.document, "flags.monks-active-tiles.files") || []);

            if (this.document._images.length) {
                let fileindex = Math.clamp(parseInt(foundry.utils.getProperty(submitData, "flags.monks-active-tiles.fileindex")), 0, this.document._images.length - 1);
                if (this.document._images[fileindex] != this.document.texture.src) {
                    foundry.utils.setProperty(submitData, "texture.src", this.document._images[fileindex]);
                }
                if (fileindex != foundry.utils.getProperty(submitData, "flags.monks-active-tiles.fileindex")) {
                    foundry.utils.setProperty(submitData, "flags.monks-active-tiles.fileindex", fileindex);
                }
            }
        }
        await originalProcessSubmitData.call(this, event, form, submitData, options);
    };
}

// Helper Functions (formerly methods of ActiveTileConfig)

function _selectTrigger(event) {
    event.preventDefault();
    event.stopPropagation();
    let id = $(event.currentTarget).attr("value");
    let triggers = $('input[name="flags.monks-active-tiles.trigger"]', this.element).val().split(",").filter(t => !!t);
    if (triggers.includes(id)) {
        triggers.findSplice(t => t === id);
        $(`.multiple-dropdown-item.selected[value="${id}"]`, this.element).removeClass("selected");
        $(`.multiple-dropdown-option[data-id="${id}"]`, this.element).remove();
    } else {
        triggers.push(id);
        $(`.multiple-dropdown-item[value="${id}"]`, this.element).addClass("selected");
        $('.multiple-dropdown-content', this.element).append(
            $("<div>").addClass("multiple-dropdown-option flexrow").attr("data-id", id)
                .append($("<span>").html(MonksActiveTiles.triggerModes[id]))
                .append($("<div>").addClass("remove-option").html("&times;").on("click", this.removeTrigger.bind(this)))
        );
    }
    $('input[name="flags.monks-active-tiles.trigger"]', this.element).val(triggers.join(","));
    $('.multiple-dropdown-select .dropdown-list', this.element).removeClass('open');
}

function _removeTrigger(event) {
    event.preventDefault();
    event.stopPropagation();
    let li = event.currentTarget.closest(".multiple-dropdown-option");
    let id = li.dataset.id;
    let triggers = $('input[name="flags.monks-active-tiles.trigger"]', this.element).val().split(",");
    triggers.findSplice(t => t === id);
    $('input[name="flags.monks-active-tiles.trigger"]', this.element).val(triggers.join(","));
    li.remove();
    $(`.multiple-dropdown-item.selected[value="${id}"]`, this.element).removeClass("selected");
}

function _onDragStart(event) {
    let li = event.currentTarget.closest(".entry");
    let list = event.currentTarget.closest("[data-collection]");
    if (list && li) {
        const dragData = {
            type: this.document.constructor.documentName,
            tileId: this.document.id,
            collection: list.dataset.collection,
            id: li.dataset.entryId
        };
        event.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    }
}

async function _onDrop(event) {
    let data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    let target = event.target.closest(".entry") || null;
    const list = event.target.closest("[data-collection]") || null;
    const collection = list?.dataset?.collection || null;

    const actions = this.document.getFlag("monks-active-tiles", "actions") || [];
    const files = this.document.getFlag("monks-active-tiles", "files") || [];
    const currentCollection = collection === "actions" ? actions : files;

    if (data.tileId != this.document.id && collection) {
        if (data.collection == collection) {
            let src = canvas.scene.tiles.get(data.tileId);
            let entry = foundry.utils.getProperty(src, `flags.monks-active-tiles.${collection}`)?.find(a => a.id == data.id);

            if (entry) {
                let newEntry = foundry.utils.duplicate(entry);
                newEntry.id = makeid();
                let entries = foundry.utils.duplicate(currentCollection);
                if (entries.length && !target)
                    target = this.element.querySelector(`li[data-entry-id="${entries[0].id}"]`);
                let to = entries.findIndex(a => a.id == target?.dataset.entryId);
                if (to === -1) to = 0;
                entries.splice(to, 0, newEntry);
                await this.document.setFlag("monks-active-tiles", collection, entries);
                this.render();
            }
        }
    } else if (collection) {
        if (target && target.dataset.entryId) {
            let entries = foundry.utils.duplicate(currentCollection);
            if (data.id === target.dataset.entryId) return;
            let from = entries.findIndex(a => a.id == data.id);
            let to = entries.findIndex(a => a.id == target.dataset.entryId);
            entries.splice(to, 0, entries.splice(from, 1)[0]);
            await this.document.setFlag("monks-active-tiles", collection, entries);
            this.render();
        }
    }
}

function _checkRecordHistory(event) {
    if (!$('.record-history', this.element).prop("checked"))
        $('.per-token', this.element).prop("checked", false);
}

function _checkPerToken(event) {
    if ($('.per-token', this.element).prop("checked"))
        $('.record-history', this.element).prop("checked", true);
}

function _viewHistory() {
    new TileHistory({ document: this.document }).render(true);
}

function _viewVariables() {
    new TileVariables({ document: this.document }).render(true);
}

async function _createAction(event, target, index = -1) {
    let action = { };
    this.actionconfig = await new ActionConfig({ action, parent: this, index }).render(true);
}

async function _editAction(event, target) {
    let item = target.closest('.action');
    const actions = this.document.getFlag("monks-active-tiles", "actions") || [];
    let action = actions.find(obj => obj.id == item.dataset.actionId);
    if (action != undefined)
        this.actionconfig = await new ActionConfig({ action, parent: this }).render(true);
}

function _deleteAction(event, target) {
    let item = target.closest('.action');
    this.deleteAction(item.dataset.actionId);
}

function _deleteActionMethod(id) {
    const actions = this.document.getFlag("monks-active-tiles", "actions") || [];
    let newActions = foundry.utils.duplicate(actions);
    newActions.findSplice(i => i.id == id);
    this.document.setFlag("monks-active-tiles", "actions", newActions);
    this.render();
}

function _stopSound(event, target) {
    let id = target.closest('.sound').dataset.soundId;
    if (this.document.soundeffect && this.document.soundeffect[id]) {
        this.document.soundeffect[id].stop();
        delete this.document.soundeffect[id];
    }
    MonksActiveTiles.emit('stopsound', {
        tileid: this.document.uuid,
        type: 'tile',
        userId: null,
        actionid: id
    });
    this.render();
}

function _cloneAction(id) {
    const actions = this.document.getFlag("monks-active-tiles", "actions") || [];
    let newActions = foundry.utils.duplicate(actions);
    let idx = newActions.findIndex(obj => obj.id == id);
    if (idx == -1) return;

    let action = newActions[idx];
    let clone = foundry.utils.duplicate(action);
    clone.id = makeid();
    newActions.splice(idx + 1, 0, clone);
    this.document.setFlag("monks-active-tiles", "actions", newActions);
    this.render();
}

function _browseImages(event) {
    _requestFiles.call(this, "file", event);
}

function _browseFolders(event) {
    _requestFiles.call(this, "folder", event);
}

async function _requestFiles(type, event) {
    event?.preventDefault();
    const options = {
        type: type == "folder" ? "folder" : "imagevideo",
        wildcard: true,
        callback: type == "folder" ? this.addFolder.bind(this) : this.addFile.bind(this),
    };
    const fp = new CONFIG.ux.FilePicker.implementation(options);
    return fp.browse();
}

async function _addFile(filename, filePicker) {
    if (filename != '') {
        let file = { id: makeid(), name: filename, selected: false };
        await this.addImageEntry(file);
        const files = this.document.getFlag("monks-active-tiles", "files") || [];
        let newFiles = foundry.utils.duplicate(files);
        newFiles.push(file);
        await this.document.setFlag("monks-active-tiles", "files", newFiles);
        this.render();
    }
}

async function _addFolder(foldername, filepicker) {
    let source = "data";
    let pattern = foldername;
    const browseOptions = {};

    if (typeof ForgeVTT != "undefined" && ForgeVTT.usingTheForge) {
        source = "forgevtt";
    }

    if (/\.s3\./.test(pattern)) {
        source = "s3";
        const { bucket, keyPrefix } = FilePicker.parseS3URL(pattern);
        if (bucket) {
            browseOptions.bucket = bucket;
            pattern = keyPrefix;
        }
    }

    try {
        const content = await foundry.applications.apps.FilePicker.implementation.browse(source, pattern, browseOptions);
        const files = this.document.getFlag("monks-active-tiles", "files") || [];
        let newFiles = foundry.utils.duplicate(files);
        for (let filename of content.files) {
            let ext = filename.substr(filename.lastIndexOf('.') + 1);
            if (CONST.IMAGE_FILE_EXTENSIONS[ext] != undefined) {
                let file = { id: makeid(), name: filename, selected: false }
                await this.addImageEntry(file);
                newFiles.push(file);
            }
        }
        await this.document.setFlag("monks-active-tiles", "files", newFiles);
        this.render();
    } catch (err) {
        error(err);
    }
}

async function _addImageEntry({ id, name }) {
    if (name != '') {
        let html = await foundry.applications.handlebars.renderTemplate("modules/monks-active-tiles/templates/image-partial.hbs", { id, name });
        let li = $(html);
        $(`.image-list`, this.element).append(li);
        $(".name", li)[0].addEventListener("dragstart", _onDragStart.bind(this));
    }
}

function _selectImage(event) {
    let id = event.currentTarget.closest('.image').dataset.imageId;
    const files = this.document.getFlag("monks-active-tiles", "files") || [];
    let idx = files.findIndex(f => f.id == id);
    $(`input[name="flags.monks-active-tiles.fileindex"]`, this.element).val(idx + 1);
    this.document.setFlag("monks-active-tiles", "fileindex", idx);
}

function _removeImage(event, target) {
    let id = target.closest('.image').dataset.imageId;
    const files = this.document.getFlag("monks-active-tiles", "files") || [];
    let newFiles = foundry.utils.duplicate(files);
    newFiles.findSplice(i => i.id == id);
    this.document.setFlag("monks-active-tiles", "files", newFiles);
    this.render();
}

function _saveTemplate(event, target) {
    foundry.applications.api.DialogV2.confirm({
        title: "Name of Template",
        content: `
<form>
<div class="form-group">
    <label for= "name" >Template Name</label >
    <div class="form-fields">
        <input type="text" name="name" />
    </div>
</div>
</form>`,
        form: { closeOnSubmit: true },
        yes: {
            callback: async (event, button) => {
                const fd = new foundry.applications.ux.FormDataExtended(button.form).object;
                if (!fd.name) return ui.notifications.error("Tile templates require a name");

                let templates = setting("tile-templates") || [];
                let data = this.document.toObject();
                data._id = data.id = foundry.utils.randomID();
                data.name = fd.name;
                data.visible = true;
                delete data.img;
                data.img = data.texture.src;
                data.thumbnail = data.img || "modules/monks-active-tiles/img/cube.svg";
                if (foundry.helpers.media.VideoHelper.hasVideoExtension(data.thumbnail)) {
                    const t = await foundry.helpers.media.ImageHelper.createThumbnail(data.thumbnail, { width: 60, height: 60 });
                    data.thumbnail = t.thumb;
                }
                templates.push(data);
                await game.settings.set("monks-active-tiles", "tile-templates", templates);
                ui.notifications.info("Tile information has been saved to Tile Templates.");
                if (!MonksActiveTiles.tile_directory)
                    MonksActiveTiles.tile_directory = await new TileTemplates();
                MonksActiveTiles.tile_directory.renderPopout();
            }
        },
        options: { width: 400 }
    });
}

function _getContextOptions() {
    return [
        {
            name: "Insert Above",
            icon: '<i class="far fa-objects-align-top"></i>',
            condition: () => game.user.isGM,
            callback: elem => {
                let li = $(elem).closest('.action');
                let idx = li.index();
                _createAction.call(this, null, li, idx);
            }
        },
        {
            name: "Insert Below",
            icon: '<i class="far fa-objects-align-bottom"></i>',
            condition: () => game.user.isGM,
            callback: elem => {
                let li = $(elem).closest('.action');
                let idx = li.index();
                _createAction.call(this, null, li, idx + 1);
            }
        },
        {
            name: "SIDEBAR.Duplicate",
            icon: '<i class="far fa-copy"></i>',
            condition: () => game.user.isGM,
            callback: elem => {
                let li = elem.closest('.action');
                const id = li.dataset.actionId;
                return this.cloneAction(id);
            }
        },
        {
            name: "SIDEBAR.Delete",
            icon: '<i class="fas fa-trash"></i>',
            condition: () => game.user.isGM,
            callback: elem => {
                let li = elem.closest('.action');
                const id = li.dataset.actionId;;
                foundry.applications.api.DialogV2.confirm({
                    window: { title: `${game.i18n.localize("SIDEBAR.Delete")} action` },
                    content: game.i18n.format("SIDEBAR.DeleteWarning", { type: 'action' }),
                    yes: { callback: () => this.deleteAction(id) },
                    options: {
                        top: Math.min(li.offsetTop, window.innerHeight - 350),
                        left: window.innerWidth - 720
                    }
                });
            }
        }
    ];
}

async function _onActionHoverIn(event) {
    event.preventDefault();
    if (!canvas.ready) return;
    const li = event.currentTarget;

    const actions = this.document.getFlag("monks-active-tiles", "actions") || [];
    let action = actions.find(a => a.id == li.dataset.actionId);
    if (action && action.data.entity && !['tile', 'token', 'players', 'within', 'controlled', 'previous'].includes(action.data.entity.id)) {
        let entity = await fromUuid(action.data.entity.id);
        if (entity && entity._object) {
            entity._object._onHoverIn(event);
            this._highlighted = entity;
        }
    }
}

function _onActionHoverOut(event) {
    event.preventDefault();
    if (this._highlighted) this._highlighted._object._onHoverOut(event);
    this._highlighted = null;
}
