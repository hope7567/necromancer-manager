const MODULE_ID = "necromancer-manager";

let opening = false;
let preferredMainSection = "combat";
let managerWindowState = null;

const PERMISSION_SETTINGS = {
  accessSetup: "Accès à l’onglet Groupes et créatures",
  createGroup: "Créer un groupe",
  addCreature: "Ajouter des créatures à un groupe",
  deleteGroup: "Supprimer un groupe"
};

const NO_PERMISSION = CONST.USER_ROLES.GAMEMASTER + 1;

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const pendingGMRequests = new Map();
const processedGMRequests = new Map();
let reloadPromptTimer = null;

function primaryActiveGM() {
  // Les opérations de création/suppression de documents doivent être exécutées
  // par un véritable Game Master. Un Assistant GM n'a pas nécessairement les
  // autorisations Foundry suffisantes, même s'il est considéré comme « GM » par
  // certaines API.
  return game.users?.filter(user => user.active && Number(user.role) === CONST.USER_ROLES.GAMEMASTER)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function emitGMRequest(payload) {
  game.socket.emit(SOCKET_CHANNEL, payload);
}

function requestGMOperation(action, data = {}) {
  if (Number(game.user.role) === CONST.USER_ROLES.GAMEMASTER) {
    return executeGMOperation(action, data, game.user.id);
  }

  const gm = primaryActiveGM();
  if (!gm) throw new Error("Aucun Game Master connecté ne peut exécuter cette action.");

  const requestId = foundry.utils.randomID();
  const payload = {
    type: "request",
    requestId,
    requesterId: game.user.id,
    targetGMId: gm.id,
    action,
    data
  };

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const send = () => {
      attempts += 1;
      emitGMRequest(payload);
    };

    const retry = setInterval(() => {
      if (attempts >= 6) return;
      send();
    }, 1500);

    const timeout = setTimeout(() => {
      clearInterval(retry);
      pendingGMRequests.delete(requestId);
      reject(new Error("L’action n’a pas pu être transmise au Game Master connecté. Rechargez Foundry sur les deux comptes."));
    }, 10000);

    pendingGMRequests.set(requestId, { resolve, reject, timeout, retry });
    send();
  });
}

function safeFolderNameGlobal(value) {
  return String(value ?? "Utilisateur").replace(/[\/:*?"<>|]/g, "-").trim() || "Utilisateur";
}

async function gmRootFolder() {
  const rootName = "NecromancerManager";
  const existing = game.folders.find(folder => folder.type === "Actor" && !folder.folder && String(folder.name).trim().toLowerCase() === rootName.toLowerCase());
  return existing ?? Folder.create({ name: rootName, type: "Actor", sorting: "a", folder: null });
}

async function gmUserFolder(ownerUser) {
  const root = await gmRootFolder();
  const existing = game.folders.find(folder => {
    const parentId = folder.folder?.id ?? folder.folder ?? null;
    return folder.type === "Actor" && parentId === root.id && folder.getFlag?.(MODULE_ID, "ownerUserId") === ownerUser.id;
  });
  if (existing) return existing;
  const folder = await Folder.create({ name: safeFolderNameGlobal(ownerUser.name), type: "Actor", sorting: "a", folder: root.id });
  await folder.setFlag(MODULE_ID, "ownerUserId", ownerUser.id);
  return folder;
}

async function gmActorFolder(name, ownerUser) {
  const cleanName = String(name ?? "").trim();
  const parent = await gmUserFolder(ownerUser);
  const existing = game.folders.find(folder => {
    const parentId = folder.folder?.id ?? folder.folder ?? null;
    return folder.type === "Actor" && parentId === parent.id && String(folder.name).trim().toLowerCase() === cleanName.toLowerCase();
  });
  if (existing) return existing;
  const folder = await Folder.create({ name: cleanName, type: "Actor", sorting: "a", folder: parent.id });
  await folder.setFlag(MODULE_ID, "ownerUserId", ownerUser.id);
  return folder;
}

async function gmAddMember(groupActor, memberActor) {
  for (const [target, method] of [[groupActor.system, "addMember"], [groupActor, "addMember"]]) {
    if (typeof target?.[method] !== "function") continue;
    try { await target[method](memberActor); return; } catch (_) {}
  }
  const managed = Array.from(new Set([...(groupActor.getFlag(MODULE_ID, "managedMembers") ?? []), memberActor.uuid]));
  await groupActor.setFlag(MODULE_ID, "managedMembers", managed);
}


function tokenScalingSettings() {
  const step = Math.max(0, Number(game.settings.get(MODULE_ID, "tokenScaleIncrement")) || 0);
  const creaturesPerStep = Math.max(1, Math.trunc(Number(game.settings.get(MODULE_ID, "tokenScaleEvery")) || 1));
  return { step, creaturesPerStep };
}

function groupTokenSizing(count, baseWidth = 1, baseHeight = 1, baseScaleX = 1, baseScaleY = 1) {
  const quantity = Math.max(0, Math.trunc(Number(count) || 0));
  const { step, creaturesPerStep } = tokenScalingSettings();
  // La première créature conserve strictement les dimensions et l’échelle
  // d’origine. Les paliers ne s’appliquent qu’aux créatures actives
  // supplémentaires.
  const additionalCreatures = Math.max(0, quantity - 1);
  const completedSteps = Math.floor(additionalCreatures / creaturesPerStep);
  const increment = completedSteps * step;
  const round3 = value => Math.round(Number(value) * 1000) / 1000;
  const gridDimension = value => Math.max(0.5, Math.ceil((Number(value) - 1e-8) * 2) / 2);

  const desiredWidth = Math.max(0.1, Number(baseWidth) || 1) + increment;
  const desiredHeight = Math.max(0.1, Number(baseHeight) || 1) + increment;
  const width = gridDimension(desiredWidth);
  const height = gridDimension(desiredHeight);

  // Foundry V12 n'accepte correctement que les dimensions entières ou par demi-case.
  // La correction d'échelle du sujet conserve malgré tout une progression visuelle fine.
  return {
    width,
    height,
    desiredWidth: round3(desiredWidth),
    desiredHeight: round3(desiredHeight),
    scaleX: round3((Number(baseScaleX) || 1) * desiredWidth / width),
    scaleY: round3((Number(baseScaleY) || 1) * desiredHeight / height)
  };
}

function isFlappyBallMember(actor) {
  return /^FB\s+/i.test(String(actor?.name ?? ""));
}

function activeGroupMembers(groupActor, folderId = null) {
  return gmGroupMemberActors(groupActor, folderId).filter(actor => {
    if (isFlappyBallMember(actor)) return false;
    const hp = Number(actor.system?.attributes?.hp?.value);
    return Number.isFinite(hp) && hp > 0;
  });
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nextCreatureNumber(sourceName, actors) {
  const pattern = new RegExp(`^${escapeRegExp(sourceName)}\\s+(\\d+)$`, "i");
  let highest = 0;
  for (const actor of actors ?? []) {
    const match = String(actor?.name ?? "").trim().match(pattern);
    if (match) highest = Math.max(highest, Number(match[1]) || 0);
  }
  return highest + 1;
}

function actorIdFromMemberReference(reference) {
  if (!reference) return null;
  if (typeof reference === "string") {
    const match = reference.match(/Actor\.([^.#/]+)/);
    return match?.[1] ?? (game.actors.get(reference) ? reference : null);
  }
  return reference.actorId ?? reference.id ?? reference._id ?? reference.actor?.id ?? null;
}

function gmGroupMemberActors(groupActor, folderId = null) {
  const actors = [];
  const seen = new Set();
  const refs = groupActor?.getFlag?.(MODULE_ID, "managedMembers") ?? [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const id = actorIdFromMemberReference(ref);
    const actor = id ? game.actors.get(id) : null;
    if (actor && !actor.getFlag(MODULE_ID, "groupToken") && !seen.has(actor.id)) {
      seen.add(actor.id);
      actors.push(actor);
    }
  }
  if (folderId) {
    for (const actor of game.actors) {
      const actorFolderId = actor.folder?.id ?? actor.folder ?? null;
      if (actorFolderId !== folderId || actor.id === groupActor?.id || actor.getFlag(MODULE_ID, "groupToken")) continue;
      if (!seen.has(actor.id)) {
        seen.add(actor.id);
        actors.push(actor);
      }
    }
  }
  return actors;
}

async function gmSyncPlacedGroupTokens(tokenActor, tokenName, sizing) {
  const displayMode = CONST.TOKEN_DISPLAY_MODES?.HOVER ?? 30;
  const barDisplayMode = CONST.TOKEN_DISPLAY_MODES?.OWNER_HOVER ?? 30;
  for (const scene of game.scenes ?? []) {
    const updates = [];
    const gridSize = Number(scene.grid?.size) || 100;
    for (const token of scene.tokens ?? []) {
      if (token.actorId !== tokenActor.id) continue;
      const oldWidth = Math.max(0.1, Number(token.width) || Number(tokenActor.prototypeToken?.width) || 1);
      const oldHeight = Math.max(0.1, Number(token.height) || Number(tokenActor.prototypeToken?.height) || 1);
      const centerX = Number(token.x || 0) + (oldWidth * gridSize / 2);
      const centerY = Number(token.y || 0) + (oldHeight * gridSize / 2);
      const update = {
        _id: token.id,
        name: tokenName,
        displayName: displayMode,
        displayBars: barDisplayMode,
        width: sizing.width,
        height: sizing.height,
        x: Math.round(centerX - (sizing.width * gridSize / 2)),
        y: Math.round(centerY - (sizing.height * gridSize / 2)),
        "texture.scaleX": sizing.scaleX,
        "texture.scaleY": sizing.scaleY
      };
      updates.push(update);
    }
    if (updates.length) await scene.updateEmbeddedDocuments("Token", updates);
  }
}

async function gmCreateOrUpdateGroupToken(ownerUser, group, settings, quantityOverride = null) {
  const groupActor = game.actors.get(group.actorId);
  if (!groupActor) throw new Error("Groupe Foundry introuvable.");

  const members = gmGroupMemberActors(groupActor, group.folderId);
  if (!members.length) throw new Error("Ajoutez au moins une créature au groupe avant de créer son token.");

  // La quantité doit correspondre exactement à l'onglet « Squelette » :
  // uniquement les membres à plus de 0 PV, hors membres préfixés « FB ».
  const computedQuantity = activeGroupMembers(groupActor, group.folderId).length;
  const hasQuantityOverride = quantityOverride !== null
    && quantityOverride !== undefined
    && Number.isFinite(Number(quantityOverride));
  const quantity = hasQuantityOverride
    ? Math.max(0, Math.trunc(Number(quantityOverride)))
    : computedQuantity;
  const groupName = String(group.label ?? groupActor.name ?? "Groupe").trim();
  const tokenName = `${groupName} (${quantity})`;
  const technicalName = `NM - ${tokenName}`;
  const displayMode = CONST.TOKEN_DISPLAY_MODES?.HOVER ?? 30;
  const barDisplayMode = CONST.TOKEN_DISPLAY_MODES?.OWNER_HOVER ?? 30;
  let tokenActor = game.actors.get(groupActor.getFlag(MODULE_ID, "groupTokenActorId"));
  let created = false;
  const recordedSourceId = tokenActor?.getFlag(MODULE_ID, "sourceActorId");
  const sourceActor = game.actors.get(recordedSourceId) ?? members[0];
  const baseWidth = Number(tokenActor?.getFlag(MODULE_ID, "baseTokenWidth"))
    || Number(sourceActor?.prototypeToken?.width)
    || 1;
  const baseHeight = Number(tokenActor?.getFlag(MODULE_ID, "baseTokenHeight"))
    || Number(sourceActor?.prototypeToken?.height)
    || 1;
  const baseScaleX = Number(tokenActor?.getFlag(MODULE_ID, "baseTokenScaleX"))
    || Number(sourceActor?.prototypeToken?.texture?.scaleX)
    || 1;
  const baseScaleY = Number(tokenActor?.getFlag(MODULE_ID, "baseTokenScaleY"))
    || Number(sourceActor?.prototypeToken?.texture?.scaleY)
    || 1;
  const sizing = groupTokenSizing(quantity, baseWidth, baseHeight, baseScaleX, baseScaleY);

  if (!tokenActor) {
    const actorData = sourceActor.toObject();
    delete actorData._id;
    actorData.name = technicalName;
    actorData.folder = group.folderId ?? groupActor.folder?.id ?? null;
    actorData.ownership = {
      default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
      [ownerUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
    };
    actorData.flags = foundry.utils.mergeObject(actorData.flags ?? {}, {
      [MODULE_ID]: {
        ownerUserId: ownerUser.id,
        groupToken: true,
        groupKey: group.key,
        sourceActorId: sourceActor.id,
        baseTokenWidth: baseWidth,
        baseTokenHeight: baseHeight,
        baseTokenScaleX: baseScaleX,
        baseTokenScaleY: baseScaleY,
        tokenSizingMode: "grid-and-subject-scale-v2"
      }
    }, { inplace: false });
    actorData.prototypeToken = foundry.utils.mergeObject(actorData.prototypeToken ?? {}, {
      name: tokenName,
      displayName: displayMode,
      displayBars: barDisplayMode,
      actorLink: true,
      width: sizing.width,
      height: sizing.height,
      texture: foundry.utils.mergeObject(actorData.prototypeToken?.texture ?? {}, {
        scaleX: sizing.scaleX,
        scaleY: sizing.scaleY
      }, { inplace: false })
    }, { inplace: false });
    tokenActor = await Actor.create(actorData);
    await groupActor.setFlag(MODULE_ID, "groupTokenActorId", tokenActor.id);
    created = true;
  } else {
    // Retour au mécanisme stable utilisé auparavant : mise à jour du token
    // prototype au travers de l'Actor, avec dimensions de grille compatibles
    // et correction d'échelle du sujet pour la taille visuelle intermédiaire.
    await tokenActor.update({
      name: technicalName,
      "prototypeToken.name": tokenName,
      "prototypeToken.displayName": displayMode,
      "prototypeToken.displayBars": barDisplayMode,
      "prototypeToken.actorLink": true,
      "prototypeToken.width": sizing.width,
      "prototypeToken.height": sizing.height,
      "prototypeToken.texture.scaleX": sizing.scaleX,
      "prototypeToken.texture.scaleY": sizing.scaleY,
      [`flags.${MODULE_ID}.baseTokenWidth`]: baseWidth,
      [`flags.${MODULE_ID}.baseTokenHeight`]: baseHeight,
      [`flags.${MODULE_ID}.baseTokenScaleX`]: baseScaleX,
      [`flags.${MODULE_ID}.baseTokenScaleY`]: baseScaleY,
      [`flags.${MODULE_ID}.tokenSizingMode`]: "grid-and-subject-scale-v2"
    });
  }

  await gmSyncPlacedGroupTokens(tokenActor, tokenName, sizing);
  return {
    tokenActorId: tokenActor.id,
    created,
    quantity,
    width: sizing.width,
    height: sizing.height,
    desiredWidth: sizing.desiredWidth,
    desiredHeight: sizing.desiredHeight,
    scaleX: sizing.scaleX,
    scaleY: sizing.scaleY,
    name: tokenName
  };
}

async function executeGMOperation(action, data, requesterId) {
  const requester = game.users.get(requesterId);
  if (!requester) throw new Error("Utilisateur demandeur introuvable.");

  const permissionKey = {
    createGroup: "createGroup",
    addCreature: "addCreature",
    deleteGroup: "deleteGroup",
    syncGroupToken: "addCreature",
    setGroupInitiative: "accessSetup"
  }[action];
  if (!permissionKey || !hasModulePermission(permissionKey, requester)) throw new Error("Permission insuffisante.");

  const ownerUserId = String(data.ownerUserId ?? requester.id);
  const ownerUser = game.users.get(ownerUserId);
  if (!ownerUser) throw new Error("Propriétaire introuvable.");
  if (!requester.isGM && ownerUser.id !== requester.id) throw new Error("Un joueur ne peut modifier que sa propre horde.");

  const FLAG_SCOPE = "world";
  const FLAG_KEY = "skeletorsMacro";

  if (action === "createGroup") {
    const cleanName = String(data.name ?? "").trim();
    if (!cleanName) throw new Error("Le nom du groupe est obligatoire.");
    const settings = (await ownerUser.getFlag(FLAG_SCOPE, FLAG_KEY)) ?? {};
    const groups = (Array.isArray(settings.groups) ? settings.groups : []).filter(group => group?.actorId && game.actors.get(group.actorId));
    if (groups.some(group => String(group.label ?? "").toLowerCase() === cleanName.toLowerCase())) throw new Error("Un groupe portant ce nom existe déjà.");
    const folder = await gmActorFolder(cleanName, ownerUser);
    const actor = await Actor.create({
      name: cleanName, type: "group", folder: folder.id,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [ownerUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
      flags: { [MODULE_ID]: { ownerUserId: ownerUser.id } }
    });
    const group = { key: foundry.utils.randomID(), actorId: actor.id, folderId: folder.id, label: actor.name };
    groups.push(group);
    await ownerUser.setFlag(FLAG_SCOPE, FLAG_KEY, { ...settings, groups });
    return { group, ownerUserId: ownerUser.id };
  }

  const settings = (await ownerUser.getFlag(FLAG_SCOPE, FLAG_KEY)) ?? {};
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const group = groups.find(entry => entry.key === data.groupKey);
  if (!group) throw new Error("Groupe introuvable.");

  if (action === "syncGroupToken") {
    return gmCreateOrUpdateGroupToken(ownerUser, group, settings, data.activeQuantity);
  }

  if (action === "setGroupInitiative") {
    const groupActor = game.actors.get(group.actorId);
    const tokenActorId = groupActor?.getFlag(MODULE_ID, "groupTokenActorId");
    const combat = game.combat;
    if (!combat || !tokenActorId) return { updated: false, reason: "no-combatant" };

    const combatant = combat.combatants.find(entry => {
      const actorId = entry.actorId ?? entry.actor?.id ?? entry.token?.actorId ?? entry.token?.actor?.id;
      return actorId === tokenActorId;
    });
    if (!combatant) return { updated: false, reason: "no-combatant" };

    const initiative = Number(data.initiative);
    if (!Number.isFinite(initiative)) throw new Error("Initiative invalide.");
    await combatant.update({ initiative });
    return { updated: true, combatantId: combatant.id, initiative };
  }

  if (action === "deleteGroup") {
    const folder = game.folders.get(group.folderId);
    const ids = new Set(group.actorId ? [group.actorId] : []);
    if (folder) for (const actor of game.actors) if ((actor.folder?.id ?? actor.folder ?? null) === folder.id) ids.add(actor.id);
    if (ids.size) await Actor.deleteDocuments(Array.from(ids));
    if (folder) await folder.delete();
    await ownerUser.setFlag(FLAG_SCOPE, FLAG_KEY, { ...settings, groups: groups.filter(entry => entry.key !== group.key) });
    return { deleted: true };
  }

  if (action === "addCreature") {
    const sourceActor = game.actors.get(String(data.sourceActorId ?? ""));
    const groupActor = game.actors.get(group.actorId);
    if (!sourceActor || !groupActor) throw new Error("Créature ou groupe introuvable.");
    const folder = game.folders.get(group.folderId) ?? await gmActorFolder(group.label, ownerUser);
    const amount = Math.max(1, Math.min(100, Number(data.quantity) || 1));
    const createdIds = [];
    const existingMembers = gmGroupMemberActors(groupActor, folder.id);
    const firstNumber = nextCreatureNumber(sourceActor.name, existingMembers);
    for (let offset = 0; offset < amount; offset++) {
      const actorData = sourceActor.toObject();
      delete actorData._id;
      actorData.name = `${sourceActor.name} ${firstNumber + offset}`;
      actorData.folder = folder.id;
      actorData.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [ownerUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
      actorData.flags = foundry.utils.mergeObject(actorData.flags ?? {}, { [MODULE_ID]: { ownerUserId: ownerUser.id } }, { inplace: false });
      const actor = await Actor.create(actorData);
      createdIds.push(actor.id);
      await gmAddMember(groupActor, actor);
    }
    if (groupActor.getFlag(MODULE_ID, "groupTokenActorId")) {
      await gmCreateOrUpdateGroupToken(ownerUser, group, settings);
    }
    return { createdIds, count: createdIds.length };
  }
}

function scheduleReloadPrompt() {
  clearTimeout(reloadPromptTimer);
  reloadPromptTimer = setTimeout(() => {
    Dialog.confirm({
      title: "Recharger Foundry VTT",
      content: "<p>Les permissions de Necromancer Manager ont été modifiées.</p><p>Rechargez Foundry VTT pour appliquer correctement ces paramètres.</p>",
      yes: () => window.location.reload(),
      no: () => {},
      defaultYes: true
    });
  }, 250);
}

function roleChoices() {
  const roles = CONST.USER_ROLES;
  return {
    [roles.PLAYER]: "Player",
    [roles.TRUSTED]: "Trusted Player",
    [roles.ASSISTANT]: "Assistant GM",
    [roles.GAMEMASTER]: "Game Master",
    [NO_PERMISSION]: "None"
  };
}

function roleLabel(user) {
  const labels = {
    [CONST.USER_ROLES.NONE]: "None",
    [CONST.USER_ROLES.PLAYER]: "Player",
    [CONST.USER_ROLES.TRUSTED]: "Trusted Player",
    [CONST.USER_ROLES.ASSISTANT]: "Assistant GM",
    [CONST.USER_ROLES.GAMEMASTER]: "Game Master"
  };
  return labels[Number(user?.role)] ?? `Rôle ${user?.role ?? "?"}`;
}

function configuredPermission(key) {
  return Number(game.settings.get(MODULE_ID, key) ?? CONST.USER_ROLES.PLAYER);
}

function permissionMinimumRole(key) {
  const configured = configuredPermission(key);
  if (key === "accessSetup") return configured;

  // Une fonctionnalité située dans l'onglet ne peut jamais être plus
  // accessible que l'onglet lui-même.
  const accessMinimum = configuredPermission("accessSetup");
  return Math.max(configured, accessMinimum);
}

function hasModulePermission(key, user = game.user) {
  const requiredRole = permissionMinimumRole(key);
  if (requiredRole === NO_PERMISSION) return false;
  return Number(user?.role ?? CONST.USER_ROLES.NONE) >= requiredRole;
}

let synchronizingPermissionHierarchy = false;
async function enforcePermissionHierarchy(changedKey = null) {
  if (synchronizingPermissionHierarchy || !game.user?.isGM) return;
  synchronizingPermissionHierarchy = true;
  try {
    const accessMinimum = configuredPermission("accessSetup");

    // Quand l'accès général devient plus restrictif, toutes les permissions
    // internes suivent automatiquement ce seuil. Exemple : accès Assistant GM
    // => seules les valeurs Assistant GM, Game Master ou None restent valides.
    for (const key of Object.keys(PERMISSION_SETTINGS)) {
      if (key === "accessSetup") continue;
      const configured = configuredPermission(key);
      if (configured < accessMinimum) {
        await game.settings.set(MODULE_ID, key, accessMinimum);
      }
    }

    // Empêche également l'enregistrement manuel d'une permission interne
    // plus faible que le droit d'accès à l'onglet.
    if (changedKey && changedKey !== "accessSetup") {
      const configured = configuredPermission(changedKey);
      if (configured < accessMinimum) {
        await game.settings.set(MODULE_ID, changedKey, accessMinimum);
      }
    }
  } finally {
    synchronizingPermissionHierarchy = false;
  }
}

class NecromancerPermissionsConfig extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "necromancer-manager-permissions",
      title: "Necromancer Manager — Permissions",
      width: 560,
      height: "auto",
      closeOnSubmit: true
    });
  }

  async _renderInner() {
    const choices = roleChoices();
    const rows = Object.entries(PERMISSION_SETTINGS).map(([key, label]) => {
      const current = String(game.settings.get(MODULE_ID, key));
      const options = Object.entries(choices).map(([value, role]) =>
        `<option value="${value}" ${String(value) === current ? "selected" : ""}>${role}</option>`
      ).join("");
      return `<div class="form-group"><label>${label}</label><select name="${key}" class="nm-select">${options}</select></div>`;
    }).join("");

    return $(`<form class="flexcol"><p class="notes">Choisissez le rôle minimal autorisé. Le MJ conserve toujours tous les droits.</p>${rows}<footer class="sheet-footer flexrow"><button type="submit"><i class="far fa-save"></i> Enregistrer</button></footer></form>`);
  }

  async _updateObject(_event, formData) {
    for (const key of Object.keys(PERMISSION_SETTINGS)) {
      await game.settings.set(MODULE_ID, key, Number(formData[key]));
    }
    ui.notifications.info("Permissions de Necromancer Manager enregistrées.");
  }
}

/**
 * Ouvre l'interface complète de gestion de horde.
 * Le corps ci-dessous reprend la macro fournie sans suppression fonctionnelle.
 */
export async function openNecromancerManager(requestedUserId = null) {
  if (opening) return;
  opening = true;

  try {
    // =========================
        // Multi-onglets (DIST / CAC)
        // =========================
        let GROUPS = [];

        const FLAG_SCOPE = "world";
        const FLAG_KEY = "skeletorsMacro";

        const requestedUser = requestedUserId ? game.users.get(requestedUserId) : null;
        const targetUser = game.user.isGM
            ? (requestedUser ?? game.user)
            : game.user;
        const targetUserId = targetUser.id;

        const canAccessSetup = hasModulePermission("accessSetup");
        const canCreateGroup = hasModulePermission("createGroup");
        const canAddCreature = hasModulePermission("addCreature");
        const canDeleteGroup = hasModulePermission("deleteGroup");

        // ===== FlappyBall prefix =====
        const FB_PREFIX = "FB";
        function stripFBPrefix(name) { return String(name ?? "").replace(new RegExp(`^${FB_PREFIX}\\s+`, "i"), ""); }
        function hasFBPrefix(name) { return new RegExp(`^${FB_PREFIX}\\s+`, "i").test(String(name ?? "")); }

        async function loadAllSettings() {
            return (await targetUser.getFlag(FLAG_SCOPE, FLAG_KEY)) ?? {};
        }

        async function saveAllSettings(patch) {
            if (!game.user.isGM && targetUserId !== game.user.id) {
                throw new Error("Vous ne pouvez modifier que vos propres groupes.");
            }

            const current = (await targetUser.getFlag(FLAG_SCOPE, FLAG_KEY)) ?? {};
            const next = { ...current, ...patch };
            if (patch.perActor) next.perActor = { ...(current.perActor ?? {}), ...patch.perActor };
            if (patch.groupLabels) next.groupLabels = { ...(current.groupLabels ?? {}), ...patch.groupLabels };
            await targetUser.setFlag(FLAG_SCOPE, FLAG_KEY, next);
            return next;
        }

        function getGroupActorByName(name) {
            const wanted = String(name ?? "").trim();
            if (!wanted) return null;
            return game.actors.getName(wanted) ?? null;
        }

        function getGroupActorForGroup(group) {
            if (!group) return null;
            if (group.actorId) {
                const actor = game.actors.get(group.actorId);
                if (actor) return actor;
            }
            const currentLabel = String(group.label ?? group.key ?? "").trim();
            return getGroupActorByName(currentLabel);
        }

        function getGroupMembers(actor) {
            if (!actor) return [];
            const sys = actor.system ?? actor.data?.data;
            const candidates = [
                sys?.members, sys?.party?.members, sys?.group?.members,
                sys?.members?.contents, sys?.party?.members?.contents, sys?.group?.members?.contents
            ];
            for (const c of candidates) { if (Array.isArray(c)) return c; if (c && typeof c.size === "number") return Array.from(c); }
            const flagCandidates = [
                actor.getFlag?.("party", "members"),
                actor.getFlag?.("party-overview", "members"),
                actor.getFlag?.("group", "members")
            ].filter(Boolean);
            for (const c of flagCandidates) { if (Array.isArray(c)) return c; if (c && typeof c.size === "number") return Array.from(c); }

            const managedMembers = actor.getFlag?.(MODULE_ID, "managedMembers") ?? [];
            if (Array.isArray(managedMembers)) return managedMembers;

            return [];
        }

        function readNameFromMember(m) {
            if (!m) return null;
            if (typeof m === "string") return m;
            if (typeof m === "object") return (m.name ?? m.label ?? m.actorName ?? m.actor?.name ?? m.actor?.data?.name ?? m.document?.name ?? m.value?.name ?? m.data?.name ?? null);
            return null;
        }

        // ===== HP getters (Actor OR Token synthetic data) =====
        function getHPValueFrom(doc) {
            const v = doc?.system?.attributes?.hp?.value;
            return (typeof v === "number") ? v : (v != null ? Number(v) : null);
        }
        function getHPTempFrom(doc) {
            const t = doc?.system?.attributes?.hp?.temp;
            return (typeof t === "number") ? t : (t != null ? Number(t) : 0);
        }
        function getHPMaxFrom(doc) {
            const m = doc?.system?.attributes?.hp?.max;
            const n = (typeof m === "number") ? m : (m != null ? Number(m) : null);
            return (Number.isFinite(n) && n > 0) ? n : null;
        }

        // Cherche un token pertinent sur la scène (priorité: contrôlé, sinon 1er trouvé)
        function findSceneTokenForActorId(actorId) {
            const tokens = canvas?.tokens?.placeables?.filter(t => t?.actor?.id === actorId) ?? [];
            if (!tokens.length) return null;
            const controlled = tokens.find(t => t.controlled);
            return controlled ?? tokens[0];
        }

        // Résout un membre en { actor, token }.
        async function resolveMember(ref) {
            let actor = null;

            if (!ref) return null;
            if (ref instanceof Actor) actor = ref;
            else if (typeof ref === "string") {
                actor = game.actors.get(ref) ?? (await fromUuid(ref).catch(() => null)) ?? game.actors.getName(ref) ?? null;
            } else if (typeof ref === "object") {
                const uuid = ref.uuid ?? ref.actorUuid ?? ref.actorUUID ?? ref.actor?.uuid ?? null;
                const id = ref.actorId ?? ref.id ?? ref._id ?? ref.actor?.id ?? ref.actor?._id ?? null;
                const name = readNameFromMember(ref);
                actor = (id ? game.actors.get(id) : null)
                    ?? (uuid ? await fromUuid(uuid).catch(() => null) : null)
                    ?? (name ? game.actors.getName(name) : null)
                    ?? null;
            }
            if (!actor) return null;

            const token = findSceneTokenForActorId(actor.id);
            return { actor, token };
        }

        // Retourne le "document HP source" : token.actor (si token non-lié) sinon actor
        function hpSource(entry) {
            if (!entry) return null;
            const { actor, token } = entry;
            const isUnlinkedToken = !!token && token.document && token.document.actorLink === false;
            return isUnlinkedToken ? token.actor : actor;
        }

        function hpMax(entry) {
            const src = hpSource(entry);
            return getHPMaxFrom(src) ?? getHPValueFrom(src) ?? 1;
        }

        // ===== DEX mod getter (token si dispo, sinon actor) =====
        function getDexModFromDoc(doc) {
            const mod = doc?.system?.abilities?.dex?.mod;
            if (Number.isFinite(mod)) return Number(mod);
            const val = doc?.system?.abilities?.dex?.value;
            if (Number.isFinite(val)) return Math.floor((Number(val) - 10) / 2);
            return 0;
        }
        function getDexMod(entry) {
            const doc = entry?.token?.actor ?? entry?.actor;
            return getDexModFromDoc(doc);
        }

        // ===== Activités utilisables disponibles pour un acteur =====
        function normalizeActivityName(value) {
            return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
        }

        function activityArray(item) {
            const activities = item?.system?.activities;
            if (!activities) return [];
            if (Array.isArray(activities)) return activities;
            if (Array.isArray(activities.contents)) return activities.contents;
            if (typeof activities.values === "function") return Array.from(activities.values());
            return Object.entries(activities).map(([id, activity]) => {
                if (activity && typeof activity === "object" && !activity.id && !activity._id) activity._id = id;
                return activity;
            }).filter(Boolean);
        }

        function activityIdOf(activity) {
            return String(activity?.id ?? activity?._id ?? "");
        }

        function activityNameOf(activity) {
            return String(
                activity?.name
                ?? activity?.title
                ?? activity?.label
                ?? activity?.constructor?.name
                ?? "Activité"
            ).trim();
        }

        function activityTypeOf(activity) {
            return String(
                activity?.type
                ?? activity?.constructor?.name
                ?? ""
            ).trim().toLowerCase();
        }

        function isUsableActivity(activity) {
            if (!activity) return false;

            const type = activityTypeOf(activity);
            const hasAttack = type.includes("attack")
                || !!activity?.attack
                || !!activity?.system?.attack;

            const save = activity?.save ?? activity?.system?.save ?? {};
            const hasSave = !!(
                save?.dc
                ?? activity?.dc
                ?? save?.ability
                ?? save?.abilities
            );

            const hasDamage = getActivityDamageParts(activity).length > 0;

            return hasAttack || hasSave || hasDamage;
        }

        function activityKindLabel(activity) {
            const type = activityTypeOf(activity);
            if (type.includes("attack") || activity?.attack || activity?.system?.attack) return "Attaque";

            const save = activity?.save ?? activity?.system?.save ?? {};
            if (save?.dc || activity?.dc || save?.ability || save?.abilities) return "Sauvegarde";

            if (getActivityDamageParts(activity).length) return "Dégâts";
            return "Activité";
        }

        function featureSelectionId(item, activity) {
            return `${String(item?.id ?? "")}:${activityIdOf(activity)}`;
        }

        function resolveFeatureSelection(actor, selectionId) {
            const raw = String(selectionId ?? "");
            const separator = raw.indexOf(":");
            if (separator < 0) return null;

            const itemId = raw.slice(0, separator);
            const activityId = raw.slice(separator + 1);
            const item = actor?.items?.get(itemId);
            if (!item) return null;

            const activity = activityArray(item).find(candidate => activityIdOf(candidate) === activityId);
            if (!activity) return null;

            return {
                id: raw,
                item,
                activity,
                itemId,
                activityId,
                name: `${item.name} — ${activityNameOf(activity)}`,
                matchKey: `${normalizeActivityName(item.name)}::${normalizeActivityName(activityNameOf(activity))}::${activityKindLabel(activity).toLowerCase()}`
            };
        }

        function getActorFeatures(actor) {
            if (!actor) return [];
            const features = [];

            for (const item of actor.items ?? []) {
                const usableActivities = activityArray(item).filter(isUsableActivity);

                for (const activity of usableActivities) {
                    const activityName = activityNameOf(activity);
                    const kind = activityKindLabel(activity);
                    const isLegacyMidi = normalizeActivityName(activityName) === "midi attack";
                    const label = isLegacyMidi
                        ? String(item.name ?? "Sans nom")
                        : `${String(item.name ?? "Sans nom")} — ${activityName || kind}`;

                    features.push({
                        id: featureSelectionId(item, activity),
                        name: label,
                        item,
                        type: String(item.type ?? ""),
                        activity,
                        activityId: activityIdOf(activity),
                        matchKey: `${normalizeActivityName(item.name)}::${normalizeActivityName(activityName)}::${kind.toLowerCase()}`
                    });
                }
            }

            return features.sort((a, b) => a.name.localeCompare(b.name));
        }

        function getActivityRollData(item, activity) {
            return activity?.getRollData?.()
                ?? item?.getRollData?.()
                ?? item?.actor?.getRollData?.()
                ?? {};
        }

        function scalarValues(value) {
            if (value == null) return [];
            if (typeof value === "string" || typeof value === "number") return [value];
            if (Array.isArray(value)) return value.flatMap(scalarValues);
            if (typeof value === "object") {
                return [value.formula, value.value, value.bonus, value.mod, value.total, value.roll]
                    .flatMap(scalarValues);
            }
            return [];
        }

        async function evaluateStaticFormula(value, rollData) {
            for (const candidate of scalarValues(value)) {
                if (typeof candidate === "number" && Number.isFinite(candidate)) return Number(candidate);
                let formula = String(candidate ?? "").trim();
                if (!formula) continue;

                formula = formula.replace(/<[^>]+>/g, "").trim();
                const displayed = formula.match(/(?:^|\s)([+\-]?\d+(?:\.\d+)?)(?:\s|$)/);
                if (/^[+\-]?\d+(?:\.\d+)?$/.test(formula)) return Number(formula);

                try {
                    const replaced = Roll.replaceFormulaData
                        ? Roll.replaceFormulaData(formula, rollData, { missing: 0 })
                        : formula;
                    const cleaned = String(replaced)
                        .replace(/\[[^\]]*\]/g, "")
                        .replace(/\b(?:1|2|3)d20(?:kh|kl)?\b/gi, "0")
                        .trim();
                    if (Roll.validate?.(cleaned)) {
                        const roll = await new Roll(cleaned).evaluate({ async: true });
                        if (Number.isFinite(roll.total)) return Number(roll.total);
                    }
                } catch (err) {
                    console.warn("Horde | Formule numérique non résolue", formula, err);
                }

                if (displayed) return Number(displayed[1]);
            }
            return null;
        }

        function damagePartFormula(part) {
            if (!part) return "";
            if (typeof part === "string") return part.trim();
            if (Array.isArray(part)) return String(part[0] ?? "").trim();

            const explicit = scalarValues(part?.formula ?? part?.roll ?? part?.value)
                .map(v => String(v ?? "").trim())
                .find(Boolean);
            if (explicit) return explicit;

            const number = Number(part?.number ?? part?.dice ?? part?.ndice);
            const faces = Number(part?.denomination ?? part?.faces ?? part?.die ?? part?.size);
            if (Number.isFinite(number) && Number.isFinite(faces) && number > 0 && faces > 0) {
                const bonus = String(part?.bonus ?? "").trim();
                return `${number}d${faces}${bonus ? (/^[+\-]/.test(bonus) ? bonus : `+${bonus}`) : ""}`;
            }
            return "";
        }

        function getActivityDamageParts(activity) {
            const damage = activity?.damage ?? activity?.system?.damage ?? {};
            const rawParts = damage?.parts;
            let parts = [];

            if (Array.isArray(rawParts)) parts = rawParts;
            else if (Array.isArray(rawParts?.contents)) parts = rawParts.contents;
            else if (rawParts && typeof rawParts.values === "function") parts = Array.from(rawParts.values());
            else if (rawParts && typeof rawParts === "object") parts = Object.values(rawParts);

            const result = parts.map((part, index) => ({
                index,
                formula: damagePartFormula(part),
                type: String(part?.types?.first?.() ?? part?.type ?? part?.damageType ?? "").trim()
            })).filter(part => part.formula);

            if (!result.length) {
                const fallback = damagePartFormula(damage?.base)
                    || String(damage?.formula ?? damage?.roll ?? activity?.formula ?? "").trim();
                if (fallback) result.push({ index: 0, formula: fallback, type: "" });
            }
            return result;
        }

        function getCriticalBonusFormulas(activity) {
            const damage = activity?.damage ?? activity?.system?.damage ?? {};
            const candidates = [
                damage?.critical?.bonus,
                damage?.critical?.formula,
                damage?.criticalBonus,
                activity?.critical?.bonus
            ];
            return candidates.flatMap(scalarValues).map(v => String(v ?? "").trim()).filter(Boolean);
        }

        function getAttackAbilityKey(item, activity) {
            const attack = activity?.attack ?? activity?.system?.attack ?? {};
            const candidates = [
                attack?.ability,
                activity?.ability,
                item?.system?.ability,
                item?.system?.attack?.ability,
                item?.system?.damage?.ability
            ];

            for (const candidate of candidates) {
                const key = String(candidate ?? "").trim().toLowerCase();
                if (["str", "dex", "con", "int", "wis", "cha"].includes(key)) return key;
            }

            const attackType = String(
                attack?.type
                ?? activity?.type
                ?? item?.system?.type?.value
                ?? item?.system?.actionType
                ?? ""
            ).toLowerCase();

            if (
                attackType.includes("ranged")
                || attackType.includes("rwak")
                || attackType.includes("rsak")
            ) return "dex";

            return "str";
        }

        function formulaAlreadyIncludesAbilityModifier(formula, abilityKey, abilityMod) {
            const compact = String(formula ?? "").replace(/\s+/g, "").toLowerCase();
            if (!compact) return false;

            const references = [
                "@mod",
                `@abilities.${abilityKey}.mod`,
                `@abilitymod`,
                `@${abilityKey}`
            ];
            if (references.some(reference => compact.includes(reference))) return true;

            // Si un bonus fixe égal au modificateur est déjà présent, ne pas le doubler.
            const signedNumbers = Array.from(compact.matchAll(/([+\-])(\d+(?:\.\d+)?)(?!d)/g))
                .map(match => Number(`${match[1]}${match[2]}`))
                .filter(Number.isFinite);

            return signedNumbers.includes(Number(abilityMod));
        }

        function addAttackAbilityModifierToDamage(item, activity, damageParts) {
            if (!Array.isArray(damageParts) || !damageParts.length) return damageParts;

            const abilityKey = getAttackAbilityKey(item, activity);
            const abilityMod = Number(item?.actor?.system?.abilities?.[abilityKey]?.mod ?? 0) || 0;
            if (!abilityMod) return damageParts;

            const first = damageParts[0];
            if (!first?.formula) return damageParts;
            if (formulaAlreadyIncludesAbilityModifier(first.formula, abilityKey, abilityMod)) return damageParts;

            return damageParts.map((part, index) => {
                if (index !== 0) return part;
                const sign = abilityMod >= 0 ? "+" : "-";
                return {
                    ...part,
                    formula: `${part.formula} ${sign} ${Math.abs(abilityMod)}`,
                    abilityModifier: {
                        ability: abilityKey,
                        value: abilityMod
                    }
                };
            });
        }

        async function getActivityAttackBonus(item, activity, rollData) {
            // Le libellé calculé par D&D5e est prioritaire : il contient le bonus total réellement affiché.
            const labelCandidates = [
                activity?.labels?.toHit,
                activity?.label?.toHit,
                item?.labels?.toHit,
                activity?.attack?.total,
                activity?.attack?.formula,
                activity?.attack?.roll
            ];
            for (const value of labelCandidates) {
                const total = await evaluateStaticFormula(value, rollData);
                if (total != null) return total;
            }

            const attack = activity?.attack ?? activity?.system?.attack ?? {};
            const flat = !!attack?.flat;
            const extra = await evaluateStaticFormula(attack?.bonus, rollData) ?? 0;
            if (flat) return extra;

            const actor = item?.actor;
            const ability = String(attack?.ability ?? activity?.ability ?? item?.system?.ability ?? "").trim();
            const abilityMod = Number(actor?.system?.abilities?.[ability]?.mod ?? 0) || 0;
            const profValue = attack?.proficient ?? item?.system?.proficient ?? true;
            const profMultiplier = profValue === true ? 1 : profValue === false ? 0 : Number(profValue) || 0;
            const proficiency = (Number(actor?.system?.attributes?.prof ?? 0) || 0) * profMultiplier;
            return abilityMod + proficiency + extra;
        }

        async function getActivitySaveData(item, activity, rollData) {
            const save = activity?.save ?? activity?.system?.save ?? {};
            const dc = await evaluateStaticFormula(
                save?.dc?.formula ?? save?.dc?.value ?? save?.dc ?? activity?.dc?.formula ?? activity?.dc?.value,
                rollData
            );
            const abilityRaw = save?.ability ?? save?.abilities ?? activity?.ability;
            const abilities = Array.isArray(abilityRaw)
                ? abilityRaw
                : abilityRaw instanceof Set
                    ? Array.from(abilityRaw)
                    : [abilityRaw];
            const ability = String(abilities.find(Boolean) ?? "").toLowerCase();
            return { dc, ability };
        }

        function getSaveDamageMode(activity) {
            const raw = String(
                activity?.damage?.onSave
                ?? activity?.system?.damage?.onSave
                ?? activity?.save?.damage
                ?? "half"
            ).toLowerCase();
            if (["none", "nodamage", "no-damage", "zero"].includes(raw)) return "none";
            if (["full", "fulldamage", "full-damage"].includes(raw)) return "full";
            return "half";
        }

        async function analyzeFeature(item, activity) {
            if (!item || !activity) return null;

            const rollData = getActivityRollData(item, activity);
            let damageParts = getActivityDamageParts(activity);
            const criticalBonusFormulas = getCriticalBonusFormulas(activity);
            const saveData = await getActivitySaveData(item, activity, rollData);

            const activityType = activityTypeOf(activity);
            const hasSave = Number.isFinite(saveData.dc) && saveData.dc > 0;
            const hasAttack = activityType.includes("attack") || !!activity?.attack || !!activity?.system?.attack;
            const hasDamage = damageParts.length > 0;

            if (hasAttack) {
                damageParts = addAttackAbilityModifierToDamage(item, activity, damageParts);
            }

            if (hasSave && !hasAttack) {
                return {
                    type: "save",
                    activity,
                    activityId: activityIdOf(activity),
                    activityName: activityNameOf(activity),
                    dc: saveData.dc,
                    ability: saveData.ability || "dex",
                    damageParts,
                    criticalBonusFormulas,
                    saveDamageMode: getSaveDamageMode(activity),
                    rollData
                };
            }

            if (hasAttack) {
                return {
                    type: "attack",
                    activity,
                    activityId: activityIdOf(activity),
                    activityName: activityNameOf(activity),
                    bonus: await getActivityAttackBonus(item, activity, rollData),
                    damageParts,
                    criticalBonusFormulas,
                    rollData
                };
            }

            if (hasDamage) {
                return {
                    type: "damage",
                    activity,
                    activityId: activityIdOf(activity),
                    activityName: activityNameOf(activity),
                    damageParts,
                    criticalBonusFormulas: [],
                    rollData
                };
            }

            return null;
        }

        async function rollDamageParts(featureInfo, critical = false) {
            const details = [];
            let total = 0;

            for (const part of featureInfo.damageParts ?? []) {
                let roll = new Roll(part.formula, featureInfo.rollData ?? {});
                if (critical && typeof roll.alter === "function") roll = roll.alter(2, 0);
                roll = await roll.evaluate({ async: true });
                details.push({ formula: part.formula, rolledFormula: roll.formula, type: part.type, total: roll.total });
                total += Number(roll.total) || 0;
            }

            if (critical) {
                for (const formula of featureInfo.criticalBonusFormulas ?? []) {
                    const roll = await new Roll(formula, featureInfo.rollData ?? {}).evaluate({ async: true });
                    details.push({ formula, rolledFormula: roll.formula, type: "critique", total: roll.total });
                    total += Number(roll.total) || 0;
                }
            }

            return { total, details };
        }

        async function collectSkeletons(group) {
            const groupActor = getGroupActorForGroup(group);
            if (!groupActor) return { error: `Groupe introuvable pour la catégorie : ${group?.label ?? group?.key ?? "?"}`, members: [], active: [], dead: [], fb: [], memberIds: new Set(), tokenIds: new Set() };

            const members = getGroupMembers(groupActor);
            const active = [], dead = [], fb = [];
            const memberIds = new Set();
            const tokenIds = new Set();

            for (const m of members) {
                const entry = await resolveMember(m);
                if (!entry) continue;

                memberIds.add(entry.actor.id);
                if (entry.token?.id) tokenIds.add(entry.token.id);

                const name = String(entry.actor.name ?? "");
                const src = hpSource(entry);
                const hp = getHPValueFrom(src);
                if (hp == null || Number.isNaN(hp)) continue;

                if (hasFBPrefix(name)) fb.push(entry);
                else if (hp > 0) active.push(entry);
                else dead.push(entry);
            }

            return { error: null, members, active, dead, fb, memberIds, tokenIds };
        }

        function doubleDiceFormula(formula) {
            const re = /(\d+)\s*d\s*(\d+)/gi;
            if (!re.test(formula)) return null;
            return formula.replace(re, (_, n, faces) => `${Number(n) * 2}d${faces}`);
        }

        function getPA(settings, aid) {
            const pa = settings?.perActor?.[aid] ?? {};
            return {
                dmg: String(pa.dmg ?? "").trim(),
                bonusAtt: Number(pa.bonusAtt ?? 0) || 0,
                aa: !!pa.aa
            };
        }

        function rowActive(entry, settings) {
            const src = hpSource(entry);
            const hp = getHPValueFrom(src) ?? 0;
            const temp = getHPTempFrom(src) ?? 0;
            const max = hpMax(entry);

            const a = entry.actor;
            const features = getActorFeatures(a);
            const selectedFeatureId = settings?.perActor?.[a.id]?.featureId ?? (features.length > 0 ? features[0].id : "");

            const featureOptions = (features.length > 0
                ? features.map(f => `<option style="color:#ffffff !important;background:#1f1f1f !important;-webkit-text-fill-color:#ffffff !important;" value="${f.id}" ${f.id === selectedFeatureId ? "selected" : ""}>${f.name}</option>`).join("")
                : `<option style="color:#ffffff !important;background:#1f1f1f !important;-webkit-text-fill-color:#ffffff !important;" value="">-- Aucune action --</option>`);

            return `<tr data-aid="${a.id}">
          <td style="text-align:center;"><input type="checkbox" class="sk-check-active sk-check-any" data-aid="${a.id}"></td>
          <td class="hm-name">
            <a class="sk-open-sheet" data-aid="${a.id}" style="cursor:pointer;text-decoration:underline;">
              <b>${a.name}</b>
            </a>
          </td>

          <td>
            <select class="nm-select sk-pa sk-pa-feature" data-aid="${a.id}" style="height:26px;width:100%;text-align:center;">
              ${featureOptions}
            </select>
          </td>


          <td>${hp}/${max}</td>
          <td>${temp}</td>
        </tr>`;
        }

        function rowDead(entry) {
            const src = hpSource(entry);
            const hp = getHPValueFrom(src) ?? 0;
            const temp = getHPTempFrom(src) ?? 0;
            const max = hpMax(entry);
            const a = entry.actor;

            return `<tr>
          <td style="text-align:center;"><input type="checkbox" class="sk-check-dead sk-check-any" data-aid="${a.id}"></td>
          <td class="hm-name">
            <a class="sk-open-sheet" data-aid="${a.id}" style="cursor:pointer;text-decoration:underline;">
              <b>${a.name}</b>
            </a>
          </td>
          <td>${hp}/${max}</td>
          <td>${temp}</td>
        </tr>`;
        }

        function rowFB(entry) {
            const a = entry.actor;
            return `<tr>
          <td style="text-align:center;"><input type="checkbox" class="sk-check-fb sk-check-any" data-aid="${a.id}"></td>
          <td class="hm-name">
            <a class="sk-open-sheet" data-aid="${a.id}" style="cursor:pointer;text-decoration:underline;">
              <b>${a.name}</b>
            </a>
          </td>
        </tr>`;
        }

        // ===== Apply updates to token (if unlinked) else actor =====
        async function applyHPUpdate(entry, hp, temp) {
            const { actor, token } = entry;
            const isUnlinkedToken = !!token && token.document && token.document.actorLink === false;

            if (isUnlinkedToken) {
                const patch = {};
                patch["actorData.system.attributes.hp.value"] = hp;
                patch["actorData.system.attributes.hp.temp"] = temp;
                await token.document.update(patch);
                return;
            }
            await Actor.updateDocuments([{ _id: actor.id, "system.attributes.hp.value": hp, "system.attributes.hp.temp": temp }]);
        }

        async function setHPValueOnly(entry, hp) {
            const { actor, token } = entry;
            const isUnlinkedToken = !!token && token.document && token.document.actorLink === false;

            if (isUnlinkedToken) {
                const patch = {};
                patch["actorData.system.attributes.hp.value"] = hp;
                await token.document.update(patch);
                return;
            }
            await Actor.updateDocuments([{ _id: actor.id, "system.attributes.hp.value": hp }]);
        }

        // ===== Helpers: d20 results extraction (robuste Foundry) =====
        function getD20Results(roll) {
            const terms = roll?.terms ?? [];
            const dieTerm = terms.find(t => t?.faces === 20 && Array.isArray(t?.results));
            if (dieTerm) return dieTerm.results.map(r => r.result).filter(n => Number.isFinite(n));
            const dice0 = roll?.dice?.[0];
            if (dice0?.faces === 20 && Array.isArray(dice0?.results)) {
                return dice0.results.map(r => r.result).filter(n => Number.isFinite(n));
            }
            return [];
        }

        // =========================
        // UI / Onglets helpers
        // =========================
        function getActiveTabKey(html) {
            return String(html.find(".hm-tabs .hm-tab.is-active")?.data("tab") ?? (GROUPS[0]?.key ?? ""));
        }
        function getActiveSectionKey(html, groupKey) {
            return String(html.find(`.hm-tab-panel[data-tab="${groupKey}"] .hm-section-tabs .hm-section-tab.is-active`)?.data("section") ?? "active");
        }
        function getPanel(html, tabKey) {
            return html.find(`.hm-tab-panel[data-tab="${tabKey}"]`);
        }
        function getSection(html, groupKey, sectionKey) {
            return html.find(`.hm-tab-panel[data-tab="${groupKey}"] .hm-section[data-section="${sectionKey}"]`);
        }
        function setActiveTab(html, tabKey) {
            html.find(".hm-tabs .hm-tab-shell").removeClass("is-active");
            html.find(`.hm-tabs .hm-tab-shell[data-tab="${tabKey}"]`).addClass("is-active");
            html.find(".hm-tab-panel").removeClass("is-active");
            html.find(`.hm-tab-panel[data-tab="${tabKey}"]`).addClass("is-active");
        }
        function setActiveSection(html, groupKey, sectionKey) {
            lastActiveSectionKey = sectionKey;
            html.find(`.hm-tab-panel[data-tab="${groupKey}"] .hm-section-tabs .hm-section-tab`).removeClass("is-active");
            html.find(`.hm-tab-panel[data-tab="${groupKey}"] .hm-section-tabs .hm-section-tab[data-section="${sectionKey}"]`).addClass("is-active");
            html.find(`.hm-tab-panel[data-tab="${groupKey}"] .hm-section`).removeClass("is-active");
            html.find(`.hm-tab-panel[data-tab="${groupKey}"] .hm-section[data-section="${sectionKey}"]`).addClass("is-active");
        }
        function panelOfEvent(ev) {
            const $p = $(ev.currentTarget).closest(".hm-tab-panel");
            const tabKey = String($p.data("tab") ?? (GROUPS[0]?.key ?? ""));
            return { panel: $p, tabKey };
        }
        function sectionOfEvent(ev) {
            const $sec = $(ev.currentTarget).closest(".hm-section");
            const sectionKey = String($sec.data("section") ?? "active");
            return { section: $sec, sectionKey };
        }
        function groupByKey(tabKey) {
            return GROUPS.find(g => g.key === tabKey) ?? GROUPS[0] ?? null;
        }

        let dlg = null;
        let hookUpdate = null, hookCreate = null, hookDelete = null, hookUpdateToken = null;
        const lastMemberIdsByTab = new Map(); // tabKey -> Set(actorId)
        const lastTokenIdsByTab = new Map();  // tabKey -> Set(tokenId)
        let refreshTimer = null;
        let lastActiveSectionKey = "active";
        let lastFeatureSourceAid = null;
        let activeMainSection = canAccessSetup && preferredMainSection === "setup" ? "setup" : "combat";

        function cleanupHooks() {
            try { if (hookUpdate) Hooks.off("updateActor", hookUpdate); } catch (e) {}
            try { if (hookCreate) Hooks.off("createActor", hookCreate); } catch (e) {}
            try { if (hookDelete) Hooks.off("deleteActor", hookDelete); } catch (e) {}
            try { if (hookUpdateToken) Hooks.off("updateToken", hookUpdateToken); } catch (e) {}
            hookUpdate = hookCreate = hookDelete = hookUpdateToken = null;
        }

        const settings = await loadAllSettings();

        // Le module démarre vide. Seuls les groupes explicitement créés ici sont chargés.
        GROUPS = (Array.isArray(settings.groups) ? settings.groups : [])
            .map(group => ({
                key: String(group.key ?? group.actorId ?? foundry.utils.randomID()),
                actorId: String(group.actorId ?? ""),
                folderId: String(group.folderId ?? ""),
                label: String(group.label ?? "Groupe").trim()
            }))
            .filter(group => group.actorId && game.actors.get(group.actorId));

        async function persistGroups() {
            settings.groups = GROUPS.map(group => ({
                key: group.key,
                actorId: group.actorId,
                folderId: group.folderId ?? "",
                label: group.label
            }));
            await saveAllSettings({ groups: settings.groups });
        }

        function slugKey() {
            return `group-${foundry.utils.randomID(12)}`;
        }

        function userOptionsHTML(selectedUserId = targetUserId) {
            return Array.from(game.users)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(user => `
                    <option value="${user.id}" ${user.id === selectedUserId ? "selected" : ""}>
                        ${escapeHTML(user.name)} — ${escapeHTML(roleLabel(user))}
                    </option>
                `)
                .join("");
        }

        function safeFolderName(value) {
            return String(value ?? "Utilisateur")
                .replace(/[\\/:*?"<>|]/g, "-")
                .trim()
                || "Utilisateur";
        }


        function escapeHTML(value) {
            const element = document.createElement("div");
            element.textContent = String(value ?? "");
            return element.innerHTML;
        }

        function creatureActors() {
            const creaturesFolder = game.folders.find(folder =>
                folder.type === "Actor"
                && String(folder.name).trim().toLowerCase() === "creatures"
            );

            if (!creaturesFolder) return [];

            return game.actors
                .filter(actor => {
                    const folderId = actor.folder?.id ?? actor.folder ?? null;
                    return actor.type === "npc" && folderId === creaturesFolder.id;
                })
                .sort((a, b) => a.name.localeCompare(b.name));
        }

        function actorOptionsHTML() {
            const actors = creatureActors();
            if (!actors.length) return `<option style="color:#ffffff !important;background:#1f1f1f !important;-webkit-text-fill-color:#ffffff !important;" value="">-- Aucun PNJ dans le dossier Creatures --</option>`;
            return actors.map(actor =>
                `<option style="color:#ffffff !important;background:#1f1f1f !important;-webkit-text-fill-color:#ffffff !important;" value="${actor.id}">${escapeHTML(actor.name)}</option>`
            ).join("");
        }

        function groupOptionsHTML() {
            if (!GROUPS.length) return `<option style="color:#ffffff !important;background:#1f1f1f !important;-webkit-text-fill-color:#ffffff !important;" value="">-- Créez d'abord un groupe --</option>`;
            return GROUPS.map(group =>
                `<option style="color:#ffffff !important;background:#1f1f1f !important;-webkit-text-fill-color:#ffffff !important;" value="${group.key}">${escapeHTML(group.label)}</option>`
            ).join("");
        }

        function refreshSetupSelectors(html) {
            const sourceSelect = html.find('select[name="nmSourceActor"]');
            const targetSelect = html.find('select[name="nmTargetGroup"]');
            const tokenSelect = html.find('select[name="nmTokenGroup"]');
            const deleteSelect = html.find('select[name="nmDeleteGroup"]');

            if (sourceSelect.length) {
                const previousSource = String(sourceSelect.val() ?? "");
                sourceSelect.html(actorOptionsHTML());

                if (previousSource && game.actors.get(previousSource)?.type === "npc") {
                    sourceSelect.val(previousSource);
                }
            }

            if (targetSelect.length) {
                const previousTarget = String(targetSelect.val() ?? "");
                targetSelect.html(groupOptionsHTML());

                if (previousTarget && GROUPS.some(group => group.key === previousTarget)) {
                    targetSelect.val(previousTarget);
                }
            }

            if (tokenSelect.length) {
                const previousToken = String(tokenSelect.val() ?? "");
                tokenSelect.html(groupOptionsHTML());
                if (previousToken && GROUPS.some(group => group.key === previousToken)) tokenSelect.val(previousToken);
            }

            if (deleteSelect.length) {
                const previousDelete = String(deleteSelect.val() ?? "");
                deleteSelect.html(groupOptionsHTML());

                if (previousDelete && GROUPS.some(group => group.key === previousDelete)) {
                    deleteSelect.val(previousDelete);
                }
            }
        }

        async function getOrCreateNecromancerRootFolder() {
            const rootName = "NecromancerManager";

            const existing = game.folders.find(folder =>
                folder.type === "Actor"
                && !folder.folder
                && String(folder.name).trim().toLowerCase() === rootName.toLowerCase()
            );
            if (existing) return existing;

            return Folder.create({
                name: rootName,
                type: "Actor",
                sorting: "a",
                folder: null
            });
        }

        async function getOrCreateUserFolder(ownerUser = targetUser) {
            const rootFolder = await getOrCreateNecromancerRootFolder();
            const userFolderName = safeFolderName(ownerUser.name);

            const existing = game.folders.find(folder => {
                const parentId = folder.folder?.id ?? folder.folder ?? null;
                return folder.type === "Actor"
                    && parentId === rootFolder.id
                    && folder.getFlag?.(MODULE_ID, "ownerUserId") === ownerUser.id;
            });
            if (existing) return existing;

            const folder = await Folder.create({
                name: userFolderName,
                type: "Actor",
                sorting: "a",
                folder: rootFolder.id
            });
            await folder.setFlag(MODULE_ID, "ownerUserId", ownerUser.id);
            return folder;
        }

        async function getOrCreateActorFolder(name, ownerUser = targetUser) {
            const cleanName = String(name ?? "").trim();
            if (!cleanName) return null;

            const userFolder = await getOrCreateUserFolder(ownerUser);

            const existing = game.folders.find(folder => {
                const parentId = folder.folder?.id ?? folder.folder ?? null;
                return folder.type === "Actor"
                    && parentId === userFolder.id
                    && String(folder.name).trim().toLowerCase() === cleanName.toLowerCase();
            });
            if (existing) return existing;

            const folder = await Folder.create({
                name: cleanName,
                type: "Actor",
                sorting: "a",
                folder: userFolder.id
            });
            await folder.setFlag(MODULE_ID, "ownerUserId", ownerUser.id);
            return folder;
        }

        async function createManagedGroup(name, ownerUserId = targetUserId) {
            if (!canCreateGroup) throw new Error("Vous n’avez pas la permission de créer un groupe.");
            if (!game.user.isGM) {
                const response = await requestGMOperation("createGroup", { name, ownerUserId: game.user.id });
                const ownerUser = game.users.get(response.ownerUserId);
                return { group: response.group, ownerUser };
            }

            const ownerUser = game.users.get(ownerUserId);
            if (!ownerUser) throw new Error("Le propriétaire sélectionné est introuvable.");
            if (!game.user.isGM && ownerUser.id !== game.user.id) {
                throw new Error("Seul le MJ peut attribuer un groupe à un autre utilisateur.");
            }

            const cleanName = String(name ?? "").trim();
            if (!cleanName) throw new Error("Le nom du groupe est obligatoire.");

            const ownerSettings = (await ownerUser.getFlag(FLAG_SCOPE, FLAG_KEY)) ?? {};
            const ownerGroups = (Array.isArray(ownerSettings.groups) ? ownerSettings.groups : [])
                .filter(group => group?.actorId && game.actors.get(group.actorId));
            if (ownerGroups.some(group => String(group.label ?? "").toLowerCase() === cleanName.toLowerCase())) {
                throw new Error("Un groupe portant ce nom existe déjà pour cet utilisateur.");
            }

            const folder = await getOrCreateActorFolder(cleanName, ownerUser);
            const actor = await Actor.create({
                name: cleanName,
                type: "group",
                folder: folder?.id ?? null,
                ownership: {
                    default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
                    [ownerUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                },
                flags: { [MODULE_ID]: { ownerUserId: ownerUser.id } }
            });

            const group = { key: slugKey(), actorId: actor.id, folderId: folder?.id ?? "", label: actor.name };
            ownerGroups.push(group);
            await ownerUser.setFlag(FLAG_SCOPE, FLAG_KEY, { ...ownerSettings, groups: ownerGroups });

            if (ownerUser.id === targetUserId) {
                GROUPS.push(group);
                settings.groups = ownerGroups;
            }
            return { group, ownerUser };
        }

        async function removeManagedGroup(group, deleteActor = true) {
            if (!group) return;
            if (!game.user.isGM) {
                await requestGMOperation("deleteGroup", { ownerUserId: targetUserId, groupKey: group.key, deleteActor });
                GROUPS = GROUPS.filter(candidate => candidate.key !== group.key);
                return;
            }

            const rootFolder = game.folders.find(candidate =>
                candidate.type === "Actor"
                && !candidate.folder
                && String(candidate.name).trim().toLowerCase() === "necromancermanager"
            );

            const folder = game.folders.get(group.folderId)
                ?? game.folders.find(candidate => {
                    const parentId = candidate.folder?.id ?? candidate.folder ?? null;
                    return candidate.type === "Actor"
                        && (!rootFolder || parentId === rootFolder.id)
                        && String(candidate.name).trim().toLowerCase() === String(group.label).trim().toLowerCase();
                });

            GROUPS = GROUPS.filter(candidate => candidate.key !== group.key);
            await persistGroups();

            try {
                const actorIds = new Set();

                if (folder) {
                    for (const actor of game.actors) {
                        const actorFolderId = actor.folder?.id ?? actor.folder ?? null;
                        if (actorFolderId === folder.id) actorIds.add(actor.id);
                    }
                }

                if (deleteActor && group.actorId) {
                    actorIds.add(group.actorId);
                }

                if (actorIds.size) {
                    await Actor.deleteDocuments(Array.from(actorIds));
                }

                if (folder) {
                    await folder.delete();
                }
            } catch (error) {
                console.error("Necromancer Manager | Suppression complète du groupe impossible", error);
                ui.notifications.error(
                    `La suppression complète de « ${group.label} » a échoué. Consultez la console.`
                );
                throw error;
            }
        }

        async function addActorToFoundryGroup(groupActor, memberActor) {
            if (!groupActor || !memberActor) return;

            // APIs D&D5e possibles selon la version.
            const candidates = [
                [groupActor.system, "addMember"],
                [groupActor, "addMember"]
            ];

            for (const [target, method] of candidates) {
                if (typeof target?.[method] !== "function") continue;
                try {
                    await target[method](memberActor);
                    return;
                } catch (error) {
                    console.debug("Necromancer Manager | API addMember indisponible", error);
                }
            }

            // Écriture directe, compatible avec plusieurs schémas connus.
            const rawMembers = getGroupMembers(groupActor);
            const refs = rawMembers.map(member => {
                if (typeof member === "string") return member;
                return member?.uuid ?? member?.actorUuid ?? member?.actorUUID ?? member?.actor?.uuid ?? member;
            }).filter(Boolean);

            if (!refs.includes(memberActor.uuid) && !refs.includes(memberActor.id)) refs.push(memberActor.uuid);

            let nativeUpdated = false;
            try {
                await groupActor.update({ "system.members": refs });
                nativeUpdated = true;
            } catch (firstError) {
                try {
                    await groupActor.update({
                        "system.members": refs.map(ref => typeof ref === "string" ? { uuid: ref } : ref)
                    });
                    nativeUpdated = true;
                } catch (secondError) {
                    console.warn("Necromancer Manager | Impossible d'écrire system.members", firstError, secondError);
                }
            }

            // Secours interne : les fonctions du module retrouveront toujours les membres.
            const fallback = Array.from(new Set([
                ...(groupActor.getFlag(MODULE_ID, "managedMembers") ?? []),
                memberActor.uuid
            ]));
            await groupActor.setFlag(MODULE_ID, "managedMembers", fallback);

            if (!nativeUpdated) {
                ui.notifications.warn(
                    `${memberActor.name} a été ajouté dans Necromancer Manager, mais la feuille native du groupe peut ne pas l'afficher avec cette version de D&D5e.`
                );
            }
        }

        async function createOrUpdateGroupToken(group, activeQuantity = null) {
            if (!group) throw new Error("Sélectionnez un groupe.");
            if (!canAddCreature) throw new Error("Vous n’avez pas la permission de gérer le token du groupe.");
            if (!game.user.isGM) {
                return requestGMOperation("syncGroupToken", { ownerUserId: targetUserId, groupKey: group.key, activeQuantity });
            }
            const ownerSettings = (await targetUser.getFlag(FLAG_SCOPE, FLAG_KEY)) ?? {};
            return gmCreateOrUpdateGroupToken(targetUser, group, ownerSettings, activeQuantity);
        }

        async function syncExistingGroupTokenFromCurrentList(group) {
            if (!group) return;
            const groupActor = getGroupActorForGroup(group);
            const tokenActorId = groupActor?.getFlag(MODULE_ID, "groupTokenActorId");
            if (!tokenActorId || !game.actors.get(tokenActorId)) return;

            // Réutilise exactement la méthode du bouton. Aucun effectif calculé
            // côté joueur : le GM relit les PV enregistrés et calcule lui-même
            // le nombre de créatures actives.
            await new Promise(resolve => setTimeout(resolve, 75));
            await createOrUpdateGroupToken(group);
        }

        async function duplicateCreatureIntoGroup(sourceActor, group, quantity) {
            if (!game.user.isGM) {
                const response = await requestGMOperation("addCreature", {
                    ownerUserId: targetUserId,
                    groupKey: group?.key,
                    sourceActorId: sourceActor?.id,
                    quantity
                });
                return Array.from({ length: response.count ?? 0 }, () => ({}));
            }
            const groupActor = getGroupActorForGroup(group);
            if (!sourceActor || !groupActor) throw new Error("Créature ou groupe introuvable.");

            const folder = game.folders.get(group.folderId)
                ?? await getOrCreateActorFolder(group.label);

            if (folder && groupActor.folder?.id !== folder.id) {
                await groupActor.update({ folder: folder.id });
            }

            group.folderId = folder?.id ?? "";
            await persistGroups();

            const amount = Math.max(1, Math.min(100, Number(quantity) || 1));
            const created = [];
            const existingActors = Array.from(game.actors).filter(actor => {
                const actorFolderId = actor.folder?.id ?? actor.folder ?? null;
                return actorFolderId === (folder?.id ?? null) && !actor.getFlag(MODULE_ID, "groupToken");
            });
            const firstNumber = nextCreatureNumber(sourceActor.name, existingActors);

            for (let offset = 0; offset < amount; offset++) {
                const data = sourceActor.toObject();
                delete data._id;
                data.name = `${sourceActor.name} ${firstNumber + offset}`;
                data.folder = folder?.id ?? null;
                data.ownership = {
                    default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
                    [targetUserId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                };
                data.flags = foundry.utils.mergeObject(
                    data.flags ?? {},
                    {
                        [MODULE_ID]: {
                            ownerUserId: targetUserId
                        }
                    },
                    { inplace: false }
                );

                const actor = await Actor.create(data);
                created.push(actor);
                await addActorToFoundryGroup(groupActor, actor);
            }

            return created;
        }

        async function openPlutoniumImporter() {
            const plutonium = game.modules.get("plutonium");
            if (!plutonium?.active) {
                ui.notifications.warn("Plutonium n'est pas installé ou activé.");
                return;
            }

            // L'importeur est fourni par Plutonium dans le répertoire des Acteurs.
            const actorTab = document.querySelector('[data-tab="actors"]');
            actorTab?.click();

            await new Promise(resolve => setTimeout(resolve, 150));

            const candidates = Array.from(document.querySelectorAll("button, a"));
            const button = candidates.find(element => {
                const text = `${element.textContent ?? ""} ${element.title ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
                return text.includes("plutonium") && text.includes("import");
            });

            if (button) {
                button.click();
                return;
            }

            ui.notifications.info(
                "Ouvrez le répertoire des Acteurs puis cliquez sur « Plutonium Import ». Revenez ensuite dans Necromancer Manager."
            );
        }

        async function refreshTablesForTab(html, tabKey) {
            const group = groupByKey(tabKey);
            const panel = getPanel(html, tabKey);
            if (!panel?.length) return;

            const data = await collectSkeletons(group);
            if (data.error) { ui.notifications.error(data.error); return; }
            lastMemberIdsByTab.set(tabKey, data.memberIds);
            lastTokenIdsByTab.set(tabKey, data.tokenIds);

            const activeBody = panel.find(`tbody#hm-active-${tabKey}`)[0];
            const deadBody = panel.find(`tbody#hm-dead-${tabKey}`)[0];
            const fbBody = panel.find(`tbody#hm-fb-${tabKey}`)[0];
            if (!activeBody || !deadBody || !fbBody) return;

            activeBody.innerHTML = (data.active.length
                ? data.active.map(e => rowActive(e, settings)).join("")
                : `<tr><td colspan="5" style="text-align:center;opacity:.8;padding:8px;">Aucun squelette actif.</td></tr>`);

            deadBody.innerHTML = (data.dead.length
                ? data.dead.map(rowDead).join("")
                : `<tr><td colspan="4" style="text-align:center;opacity:.8;padding:8px;">Aucun squelette à 0 PV.</td></tr>`);

            fbBody.innerHTML = (data.fb.length
                ? data.fb.map(rowFB).join("")
                : `<tr><td colspan="2" style="text-align:center;opacity:.8;padding:8px;">Aucun squelette FB.</td></tr>`);

            // Nb d'attaques = nb actifs (si pas en cours d'édition)
            const atkEl = panel.find("input[name='skAttacks']")[0];
            const isEditingAtk = atkEl && (document.activeElement === atkEl);
            if (!isEditingAtk) panel.find("input[name='skAttacks']").val(String(data.active.length || 1));
            updateSelectedSkeletonList(panel);

        }

        async function refreshAllTables(html) {
            for (const g of GROUPS) {
                await refreshTablesForTab(html, g.key);
            }
        }

        function refreshAllSoon(html) {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => refreshAllTables(html).catch(console.error), 120);
        }

        function updateSelectedSkeletonList(panel) {
            const names = panel.find("input.sk-check-active:checked").map((_, el) => {
                const row = el.closest("tr");
                return row?.querySelector(".hm-name b, .hm-name a, a.sk-open-sheet")?.textContent?.trim() || game.actors.get(el.dataset.aid)?.name || "";
            }).get().filter(Boolean);
            panel.find(".hm-selected-skeleton-list").text(names.length ? names.join(", ") : "Aucun squelette sélectionné.");
        }

        function clearUI(panel) {
            panel.find("input[name='addHP'],input[name='setTempMin'],input[name='damage']").val("");
            panel.find("input.sk-check-active,input.sk-check-dead,input.sk-check-fb,input.sk-check-any").prop("checked", false);
            updateSelectedSkeletonList(panel);
        }

        // Valeurs globales (initialisation)
        const uiAtkBonus = Number(settings.atkBonus ?? 5) || 0;
        const uiAcMin = Number(settings.acMin ?? 10) || 10;
        const uiAcMax = Number(settings.acMax ?? 20) || 20;
        const uiDmg = String(settings.dmg ?? "1d6+3");

        // HTML d'un onglet (avec sous-onglets de sections)
        function tabPanelHTML(tabKey, titleLabel) {
            return `
    <div class="hm-tab-panel ${tabKey === (GROUPS[0]?.key ?? "") ? "is-active" : ""}" data-tab="${tabKey}">
      <div class="hm-section-tabs">
        <button type="button" class="hm-section-tab is-active" data-section="active">Squelettes</button>
        <button type="button" class="hm-section-tab" data-section="abilities">Caractéristiques</button>
        <button type="button" class="hm-section-tab" data-section="dead">0 PV</button>
        <button type="button" class="hm-section-tab" data-section="fb">FlappyBall</button>
        <button type="button" class="hm-section-tab" data-section="ske">Custom</button>
      </div>

      <form>
        <div class="hm-section" data-section="ske">
          <div class="hm-card hm-ske">
            <div class="hm-head">
              <h3>Squelettes — dégâts selon CA (${titleLabel})</h3>
            </div>

            <div class="sk-grid">
              <div class="sk-grid-main">
                <div class="sk-field"><div class="lbl">Nb d'attaques</div><input type="number" name="skAttacks" min="1"></div>
                <div class="sk-field"><div class="lbl">Bonus de touche</div><input type="number" name="skAtkBonus" value="${uiAtkBonus}"></div>
                <div class="sk-field"><div class="lbl">Dégâts</div><input type="text" name="skDmg" class="nm-custom-damage-formula" value="${uiDmg}"></div>
              </div>
              <div class="sk-grid-ac">
                <div class="sk-field"><div class="lbl">CA min</div><input type="number" name="skAcMin" value="${uiAcMin}" min="1"></div>
                <div class="sk-field"><div class="lbl">CA max</div><input type="number" name="skAcMax" value="${uiAcMax}" min="1"></div>
              </div>
            </div>

            <div class="sk-actions">
              <label class="sk-toggle"><input type="checkbox" name="skAdv">Avantage</label>
              <label class="sk-toggle"><input type="checkbox" name="skDisadv">Désavantage</label>
              <button type="button" class="btn-sk-launch">Lancer</button>
            </div>
          </div>
        </div>

        <div class="hm-section is-active" data-section="active">
          <div class="hm-card hm-active">
            <div class="hm-head">
              <h3>Squelettes actifs (${titleLabel})</h3>
              <button type="button" class="btn-toggle-select-all hm-check-btn" data-check-class="sk-check-active">Cocher Actifs</button>
            </div>

            <div class="hm-table-wrap-active">
              <table class="hm-table" border="1">
                <colgroup>
                  <col class="hm-col-check">
                  <col class="hm-col-name">
                  <col class="hm-col-feature">
                  <col class="hm-col-pv">
                  <col class="hm-col-temp">
                </colgroup>
                <thead>
                  <tr>
                    <th>✔</th><th>Nom</th><th>Action</th><th>PV</th><th>PV temp</th>
                  </tr>
                </thead>
                <tbody id="hm-active-${tabKey}"><tr><td colspan="5" style="text-align:center;opacity:.8;padding:8px;">Chargement...</td></tr></tbody>
              </table>
            </div>

            <div class="hm-toolbar">
              <div class="hm-toolbar-title">Jets</div>
              <div class="hm-attack-row">
                <button type="button" class="hm-mini-btn btn-active-initiative">Initiative</button>
                <button type="button" class="hm-mini-btn btn-copy-feature">Copier action</button>
                <button type="button" class="hm-mini-btn btn-active-attack">Attaque</button>
              </div>
              <div class="hm-attack-options">
                <div class="hm-roll-mode" role="radiogroup" aria-label="Mode du jet d'attaque">
                  <label><input type="radio" name="activeAttackMode-${tabKey}" value="adv"> Avantage</label>
                  <label><input type="radio" name="activeAttackMode-${tabKey}" value="disadv"> Désavantage</label>
                  <label><input type="radio" name="activeAttackMode-${tabKey}" value="normal" checked> Normal</label>
                </div>
                <div class="hm-attack-modifier">
                  <label for="activeAttackBonus-${tabKey}">Bonus / malus attaque</label>
                  <input id="activeAttackBonus-${tabKey}" type="number" name="activeAttackBonus" value="0" step="1">
                </div>
              </div>
            </div>

            <div class="hm-toolbar">
              <div class="hm-toolbar-title">Gestion des PV</div>
              <div class="hm-ops">
                <div class="hm-field"><div class="lbl">Ajouter/retirer PV</div><input type="number" name="addHP" step="1"></div>
                <div class="hm-field"><div class="lbl">Ajouter/retirer PV temporaire</div><input type="number" name="setTempMin" step="1"></div>
              </div>
              <div class="hm-btn3">
                <button type="button" class="btn-apply">Appliquer</button>
                <button type="button" class="btn-reset-temp">Reset PV temp</button>
                <button type="button" class="btn-send-flappy"><i class="fas fa-feather-alt"></i> Envoyer vers FlappyBall</button>
              </div>
            </div>
          </div>
        </div>

        <div class="hm-section" data-section="abilities">
          <div class="hm-card hm-abilities">
            <div class="hm-head"><h3>Tests de caractéristiques (${titleLabel})</h3></div>
            <div class="hm-selected-skeletons"><strong>Squelettes sélectionnés :</strong><div class="hm-selected-skeleton-list">Aucun squelette sélectionné.</div></div>
            <div class="hm-abilities-row">
              <button type="button" class="hm-mini-btn btn-ability" data-ability="str">FOR</button>
              <button type="button" class="hm-mini-btn btn-ability" data-ability="dex">DEX</button>
              <button type="button" class="hm-mini-btn btn-ability" data-ability="con">CON</button>
              <button type="button" class="hm-mini-btn btn-ability" data-ability="int">INT</button>
              <button type="button" class="hm-mini-btn btn-ability" data-ability="wis">SAG</button>
              <button type="button" class="hm-mini-btn btn-ability" data-ability="cha">CHA</button>
            </div>
          </div>
        </div>

        <div class="hm-section" data-section="dead">
          <div class="hm-card hm-dead">
            <div class="hm-head"><h3>Squelettes à 0 PV (${titleLabel})</h3><button type="button" class="btn-toggle-select-all hm-check-btn" data-check-class="sk-check-dead">Cocher 0 PV</button></div>
            <table class="hm-table" border="1">
              <colgroup><col class="hm-col-check"><col class="hm-col-name"><col class="hm-col-pv"><col class="hm-col-temp"></colgroup>
              <thead><tr><th>✔</th><th>Nom</th><th>PV</th><th>PV temp</th></tr></thead>
              <tbody id="hm-dead-${tabKey}"><tr><td colspan="4" style="text-align:center;opacity:.8;padding:8px;">Chargement...</td></tr></tbody>
            </table>
            <div class="hm-btn1"><button type="button" class="btn-rez">Rez sélection (0 PV)</button></div>
          </div>
        </div>

        <div class="hm-section" data-section="fb">
          <div class="hm-card hm-fb">
            <div class="hm-head"><h3>Squelettes FlappyBall (${titleLabel})</h3><button type="button" class="btn-toggle-select-all hm-check-btn" data-check-class="sk-check-fb">Cocher FB</button></div>
            <table class="hm-table" border="1">
              <colgroup><col class="hm-col-check"><col class="hm-col-name"></colgroup>
              <thead><tr><th>✔</th><th>Nom</th></tr></thead>
              <tbody id="hm-fb-${tabKey}"><tr><td colspan="2" style="text-align:center;opacity:.8;padding:8px;">Chargement...</td></tr></tbody>
            </table>
            <div class="hm-btn1"><button type="button" class="btn-return-active"><i class="fas fa-undo"></i> Renvoyer vers Squelettes actifs</button></div>
          </div>
        </div>
      </form>
    </div>`;
        }

        dlg = new Dialog({
            title: "Necromancer Manager",
            width: 1020,
            resizable: true,
            content: `
    <style>
      :root{
        --hm-bg: rgba(24,26,32,.92);
        --hm-card: rgba(38,40,48,.78);
        --hm-border: rgba(255,255,255,.14);
        --hm-text: rgba(255,255,255,.92);
        --hm-green: rgba(46, 204, 113, .95);
        --hm-purple: rgba(155, 89, 182, .95);
        --hm-cyan: rgba(52, 152, 219, .95);
      }

      .app.window-app.dialog .window-content{ background: var(--hm-bg) !important; }
      .app.window-app.dialog .window-content,
      .app.window-app.dialog .window-content *{ color: var(--hm-text) !important; }


      .necromancer-manager-root input.nm-custom-damage-formula {
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        caret-color:#ffffff !important;
      }
      .nm-help-block h5 {
        margin:12px 0 4px;
        font-size:14px;
        font-weight:900;
        border-bottom:1px solid rgba(255,255,255,.14);
        padding-bottom:3px;
      }
      .nm-help-block p { margin:4px 0 7px; }
      .nm-help-block ul { margin:4px 0 8px 18px; padding:0; }
      .nm-help-block li { margin:3px 0; }

      .hm-card{
        border:1px solid var(--hm-border);
        background:var(--hm-card);
        border-radius:12px;
        padding:10px;
        box-shadow:0 5px 14px rgba(0,0,0,.30);
      }
      .hm-card+.hm-card{ margin-top:10px; }

      .app.window-app.dialog input,
      .app.window-app.dialog select,
      .app.window-app.dialog textarea{
        background: rgba(255,255,255,.10) !important;
        border: 1px solid rgba(255,255,255,.18) !important;
        border-radius: 8px !important;
      }

      .hm-head{
        --hm-accent: rgba(255,255,255,.25);
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:8px;
        margin:0 0 8px 0;
        padding:8px 10px;
        border-radius:10px;
        background: linear-gradient(90deg, rgba(255,255,255,.18), rgba(255,255,255,.08));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.10), 0 6px 14px rgba(0,0,0,.18);
      }
      .hm-head h3{ margin:0; line-height:1.1; font-weight:950; border:0 !important; }

      .hm-mini-btn{
        height:30px;
        padding:0 9px;
        border-radius:8px;
        border:1px solid rgba(255,255,255,.16) !important;
        background: rgba(255,255,255,.08) !important;
        font-weight:900;
        white-space:nowrap;
      }

      .hm-check{
        display:flex; align-items:center; gap:10px;
        margin:0; padding:5px 8px;
        border-radius:8px;
        background: rgba(0,0,0,.18);
        border: 1px solid rgba(255,255,255,.10);
        font-weight:900;
        white-space:nowrap;
      }

      .hm-check-btn{
        display:flex; align-items:center; gap:10px;
        margin:0; padding:5px 8px;
        border-radius:8px;
        background: rgba(0,0,0,.18) !important;
        border: 1px solid rgba(255,255,255,.10) !important;
        font-weight:900;
        white-space:nowrap;
        height:auto;
        width:auto;
      }

      .hm-ske .hm-head{ --hm-accent: var(--hm-cyan); }
      .hm-active .hm-head{ --hm-accent: var(--hm-green); }
      .hm-fb .hm-head{ --hm-accent: var(--hm-purple); }

      .sk-pa-feature{
        height:26px !important;
        text-align:center;
        font-size:13px;
        box-sizing:border-box !important;
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background-color:#1f1f1f !important;
        border:1px solid #555 !important;
      }
      .sk-pa-feature option{
        color: white !important;
        background-color: #333333 !important;
        padding: 4px;
      }
      .sk-pa-feature option:checked{
        background: linear-gradient(#4d94ff, #4d94ff) !important;
        color: white !important;
      }

      .sk-grid{ display:flex; flex-direction:column; gap:7px; margin-top:8px; }
      .sk-grid-main{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
      .sk-grid-ac{ display:grid; grid-template-columns:repeat(2,minmax(0,180px)); justify-content:center; gap:7px; }
      .sk-field{ display:flex; flex-direction:column; gap:3px; min-width:0; }
      .sk-field .lbl{ font-weight:800; text-align:center; font-size:12px; opacity:.9; }
      .sk-field input{ height:28px; text-align:center; font-size:13px; width:100%; box-sizing:border-box; }

      .sk-actions{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:7px; margin-top:8px; }
      .sk-actions button{ height:32px; width:100%; box-sizing:border-box; }

      .sk-toggle{
        height:32px;width:100%;
        border:1px solid rgba(255,255,255,.18);
        border-radius:8px;
        background: rgba(255,255,255,.08);
        display:flex;align-items:center;justify-content:center;gap:10px;
        box-sizing:border-box;padding:0 10px;
        font-weight:900;user-select:none;
      }
      .sk-toggle input{ margin:0; transform:translateY(1px); }

      .hm-table{ width:100%; text-align:center; border-collapse:collapse; table-layout:fixed; border-color:rgba(255,255,255,.12); font-size:12px; }
      .hm-table th{ background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.12); font-size:11px; text-transform:uppercase; letter-spacing:.25px; }
      .hm-table th,.hm-table td{ padding:5px 4px; overflow:hidden; text-overflow:ellipsis; border-color:rgba(255,255,255,.12); }
      .hm-table tbody tr:nth-child(odd){ background:rgba(255,255,255,.045); }
      .hm-table tbody tr:hover{ background:rgba(255,255,255,.10); }
      .hm-table tbody tr:has(input.sk-check-any:checked){ background:rgba(52,152,219,.20) !important; box-shadow:inset 3px 0 0 rgba(52,152,219,.85); }
      .hm-table input[type="checkbox"]{ transform:scale(1.05); margin:0; }
      .hm-table .hm-name{ text-align:center !important; padding-left:0 !important; }
      .hm-table .hm-name b{ display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

      .hm-active .hm-col-check{ width:40px; }
      .hm-active .hm-col-name{ width:160px; }
      .hm-active .hm-col-feature{ width:180px; }
      .hm-active .hm-col-pv{ width:75px; }
      .hm-active .hm-col-temp{ width:82px; }

      .hm-active .hm-table-wrap-active{ overflow-x:visible; }
      .hm-active .hm-table-wrap-active table{ min-width:0 !important; }
      .window-app.popout .hm-active .hm-table-wrap-active{ overflow-x:auto; }
      .window-app.popout .hm-active .hm-table-wrap-active table{ min-width:820px; }

      .hm-toolbar{ margin-top:8px; padding:8px; border:1px solid rgba(255,255,255,.10); border-radius:9px; background:rgba(0,0,0,.13); }
      .hm-toolbar-title{ margin:0 0 6px; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.55px; opacity:.72; }
      .hm-ops{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; margin-top:0; }
      .hm-field{ display:flex; flex-direction:column; gap:3px; min-width:0; }
      .hm-field .lbl{ font-weight:800; text-align:center; font-size:11px; opacity:.88; }
      .hm-field input{ height:28px; text-align:center; font-size:13px; width:100%; box-sizing:border-box; }

      .hm-btn3{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:7px; margin-top:7px; }
      .hm-btn1{ display:grid; grid-template-columns:1fr; gap:7px; margin-top:7px; }
      .hm-btn3 button,.hm-btn1 button{ height:31px; width:100%; box-sizing:border-box; border-radius:8px; border:1px solid rgba(255,255,255,.16) !important; background:rgba(255,255,255,.08) !important; font-weight:800; }

      .hm-attack-row{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); align-items:center; gap:7px; margin-top:0; }
      .hm-attack-row button{ width:100% !important; min-width:0; height:32px; border-radius:8px; font-weight:900; }

      .hm-attack-options{ display:grid; grid-template-columns:2fr 1fr; gap:7px; margin-top:7px; align-items:stretch; }
      .hm-roll-mode{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:5px; }
      .hm-roll-mode label{ min-width:0; height:32px; display:flex; align-items:center; justify-content:center; gap:5px; border:1px solid rgba(255,255,255,.14); border-radius:8px; background:rgba(255,255,255,.06); font-weight:800; font-size:12px; }
      .hm-roll-mode input{ margin:0; }
      .hm-attack-modifier{ display:grid; grid-template-columns:minmax(0,1fr) 72px; gap:6px; align-items:center; padding:0 7px; border:1px solid rgba(255,255,255,.14); border-radius:8px; background:rgba(255,255,255,.06); }
      .hm-attack-modifier label{ font-size:11px; font-weight:800; text-align:center; }
      .hm-attack-modifier input{ height:27px; width:100%; text-align:center; box-sizing:border-box; }

      button.btn-sk-launch{ background: rgba(231,76,60,.28) !important; border-color: rgba(231,76,60,.45) !important; }
      button.btn-apply{ background: rgba(46,204,113,.20) !important; border-color: rgba(46,204,113,.36) !important; }
      button.btn-rez{ background: rgba(243,156,18,.26) !important; border-color: rgba(243,156,18,.45) !important; }
      button.btn-send-flappy,
      .btn-return-active{ background: rgba(155,89,182,.20) !important; border-color: rgba(155,89,182,.38) !important; }

      .btn-active-initiative{
        background: rgba(52,152,219,.35) !important;
        border: 1px solid rgba(52,152,219,.70) !important;
        color: #000 !important;
        -webkit-text-fill-color:#000 !important;
        text-shadow: none !important;
      }
      .btn-copy-feature{
        background: rgba(255,255,255,.88) !important;
        border: 1px solid rgba(255,255,255,.55) !important;
        color: #000 !important;
        -webkit-text-fill-color:#000 !important;
        text-shadow: none !important;
      }
      .btn-active-attack{
        background: rgba(231,76,60,.38) !important;
        border: 1px solid rgba(231,76,60,.78) !important;
        color: #000 !important;
        -webkit-text-fill-color:#000 !important;
        text-shadow: none !important;
      }

      .hm-abilities-row{ display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:6px; margin-top:6px; }
      .hm-abilities-row button{ min-width:0; width:100%; height:32px; }

      /* === Tabs === */
      .hm-tabs{
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:6px;
        align-items:center;
        margin-bottom:8px;
        padding:6px;
        border:1px solid rgba(255,255,255,.12);
        background:rgba(255,255,255,.06);
        border-radius:12px;
      }
      .hm-tab-shell{
        display:grid;
        grid-template-columns:minmax(0,1fr) 32px;
        gap:4px;
        padding:3px;
        border:1px solid rgba(255,255,255,.12);
        border-radius:10px;
        background:rgba(0,0,0,.14);
      }
      .hm-tab{
        min-width:0;
        height:30px;
        padding:0 8px;
        border:0 !important;
        border-radius:7px;
        background:transparent !important;
        font-weight:950;
        cursor:pointer;
        user-select:none;
        overflow:hidden;
      }
      .hm-tab-label{
        display:block;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      .hm-tab-edit{
        width:100% !important;
        height:24px !important;
        margin:0 !important;
        padding:0 6px !important;
        border:1px solid rgba(52,152,219,.85) !important;
        border-radius:5px !important;
        background:#fff !important;
        color:#000 !important;
        -webkit-text-fill-color:#000 !important;
        text-align:center;
        font-weight:900;
        box-sizing:border-box;
      }
      .hm-tab-rename{
        width:32px !important;
        min-width:32px !important;
        height:30px;
        margin:0;
        padding:0 !important;
        border:0 !important;
        border-radius:7px;
        background:rgba(255,255,255,.08) !important;
        opacity:.68;
      }
      .hm-tab-rename:hover{
        opacity:1;
        background:rgba(255,255,255,.16) !important;
      }
      .hm-tab-shell.is-active{
        border-color:rgba(255,255,255,.50);
        background:rgba(255,255,255,.82);
      }
      .hm-tab-shell.is-active .hm-tab,
      .hm-tab-shell.is-active .hm-tab *,
      .hm-tab-shell.is-active .hm-tab-rename,
      .hm-tab-shell.is-active .hm-tab-rename *{
        color:#000 !important;
        -webkit-text-fill-color:#000 !important;
        text-shadow:none !important;
      }
      .hm-tab-shell.is-active .hm-tab-rename{
        background:rgba(0,0,0,.08) !important;
      }

      .hm-tab-panel{ display:none; }
      .hm-tab-panel.is-active{ display:block; }

      /* === Section Tabs === */
      .hm-section-tabs{
        display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:5px; align-items:center;
        margin-bottom:8px;
        padding:5px;
        border:1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.04);
        border-radius:10px;
      }
      .hm-section-tab{
        height:28px;
        padding:0 6px;
        border-radius:8px;
        border:1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.05);
        font-weight:900;
        font-size:13px;
        cursor:pointer;
        user-select:none;
      }
      .hm-section-tab.is-active{
        background: rgba(255,255,255,.78) !important;
        color:#000 !important;
        -webkit-text-fill-color:#000 !important;
        border-color: rgba(255,255,255,.45) !important;
      }

      .hm-section{ display:none; }
      .hm-section.is-active{ display:block; }

      .nm-top-toolbar{
        display:flex;
        flex-wrap:nowrap;
        align-items:center;
        gap:6px;
        width:100%;
        margin:0 0 10px;
        padding:5px;
        border:1px solid #6f6f6f;
        border-radius:6px;
        background:#202225;
        box-sizing:border-box;
        overflow:hidden;
      }
      .nm-main-tabs{
        display:flex;
        flex:1 1 auto;
        min-width:0;
        gap:4px;
        margin:0;
        padding:0;
        border:0;
        background:transparent;
      }
      .nm-main-tab{
        flex:1 1 0;
        min-width:0;
        min-height:30px;
        padding:0 8px !important;
        font-weight:800;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .nm-main-section{display:none;}
      .nm-main-section.is-active{display:block;}
      .nm-management-actions{display:flex;flex-wrap:wrap;gap:6px;}
      .nm-setup-block{
        margin-top:8px;padding:10px;border-radius:6px;
        border:1px solid var(--color-border-light-primary, rgba(127,127,127,.35));
        background:var(--color-bg-option, rgba(127,127,127,.08));
      }
      .nm-setup-block h4{
        margin:0 0 8px;padding-bottom:5px;
        border-bottom:1px solid var(--color-border-light-primary, rgba(127,127,127,.35));
      }
      .nm-setup-block p{margin:7px 0 0;opacity:.8;}
      .nm-import-grid label{display:flex;flex-direction:column;gap:4px;font-weight:700;}

      /* Palette native Foundry : suit automatiquement le thème utilisateur. */
      .necromancer-manager-root .window-content{
        color:var(--color-text-primary, inherit) !important;
        background:var(--background, var(--color-bg, inherit)) !important;
      }
      .necromancer-manager-root .window-content *{
        color:var(--color-text-primary, inherit) !important;
        -webkit-text-fill-color:currentColor !important;
        text-shadow:none !important;
      }
      .necromancer-manager-root .hm-card,
      .necromancer-manager-root .hm-toolbar,
      .necromancer-manager-root .hm-tabs,
      .necromancer-manager-root .hm-tab-shell,
      .necromancer-manager-root .hm-section-tabs,
      .necromancer-manager-root .hm-roll-mode label,
      .necromancer-manager-root .hm-attack-modifier,
      .necromancer-manager-root .hm-check,
      .necromancer-manager-root .hm-check-btn{
        background:var(--color-bg-option, rgba(127,127,127,.08)) !important;
        border-color:var(--color-border-light-primary, rgba(127,127,127,.35)) !important;
        box-shadow:none !important;
      }
      .necromancer-manager-root .hm-head,
      .necromancer-manager-root .hm-table th{
        background:var(--color-bg-header, var(--color-bg-option, rgba(127,127,127,.12))) !important;
        border-color:var(--color-border-light-primary, rgba(127,127,127,.35)) !important;
        box-shadow:none !important;
      }
      .necromancer-manager-root input,
      .necromancer-manager-root select,
      .necromancer-manager-root textarea{
        color:var(--color-text-primary, inherit) !important;
        background:var(--color-bg-input, var(--color-bg-option, transparent)) !important;
        border-color:var(--color-border-light-primary, rgba(127,127,127,.45)) !important;
      }
      .necromancer-manager-root .window-content select[name="nmSourceActor"],
      .necromancer-manager-root .window-content select[name="nmTargetGroup"]{
        color:#111 !important;
        -webkit-text-fill-color:#111 !important;
        background:#f3eddf !important;
        border-color:#8a7f6a !important;
      }
      .necromancer-manager-root .window-content select[name="nmSourceActor"] option,
      .necromancer-manager-root .window-content select[name="nmTargetGroup"] option{
        color:#111 !important;
        -webkit-text-fill-color:#111 !important;
        background:#f3eddf !important;
      }
      .necromancer-manager-root button{
        color:var(--color-text-primary, inherit) !important;
        background:var(--color-bg-btn, var(--color-bg-option, transparent)) !important;
        border-color:var(--color-border-light-primary, rgba(127,127,127,.45)) !important;
        text-shadow:none !important;
      }
      .necromancer-manager-root button:hover,
      .necromancer-manager-root button:focus{
        color:var(--color-text-hyperlink, var(--color-text-primary, inherit)) !important;
        border-color:var(--color-border-highlight, currentColor) !important;
        box-shadow:0 0 5px var(--color-shadow-highlight, transparent) !important;
      }
      .necromancer-manager-root .hm-tab-shell.is-active,
      .necromancer-manager-root .hm-section-tab.is-active,
      .necromancer-manager-root .nm-main-tab.is-active{
        color:var(--color-text-primary, inherit) !important;
        background:var(--color-bg-btn, var(--color-bg-option, rgba(127,127,127,.16))) !important;
        border-color:var(--color-border-highlight, currentColor) !important;
      }
      .necromancer-manager-root .hm-table,
      .necromancer-manager-root .hm-table td,
      .necromancer-manager-root .hm-table th{
        border-color:var(--color-border-light-primary, rgba(127,127,127,.35)) !important;
      }
      .necromancer-manager-root .hm-table tbody tr:nth-child(odd){background:rgba(127,127,127,.04) !important;}
      .necromancer-manager-root .hm-table tbody tr:hover{background:rgba(127,127,127,.10) !important;}
      .necromancer-manager-root .btn-active-initiative,
      .necromancer-manager-root .btn-copy-feature,
      .necromancer-manager-root .btn-active-attack,
      .necromancer-manager-root .btn-sk-launch,
      .necromancer-manager-root .btn-apply,
      .necromancer-manager-root .btn-rez,
      .necromancer-manager-root .btn-send-flappy,
      .btn-return-active{
        color:var(--color-text-primary, inherit) !important;
        background:var(--color-bg-btn, var(--color-bg-option, transparent)) !important;
        border-color:var(--color-border-light-primary, rgba(127,127,127,.45)) !important;
      }

      .nm-group-manager{ margin-bottom:8px; }
      .nm-import-grid{
        display:grid;
        grid-template-columns:2fr 90px 2fr 1.4fr;
        gap:7px;
        align-items:end;
      }
      .nm-import-grid select,
      .nm-import-grid input{
        height:32px !important;
        width:100%;
        box-sizing:border-box;
      }
      .nm-import-grid .btn-add-creature{
        height:32px !important;
        margin:0 !important;
        align-self:end;
      }
      @media (max-width:800px){
        .nm-import-grid{ grid-template-columns:1fr 1fr; }
      }
    
      /* === Refonte nécromantique === */
      .necromancer-manager-root .window-content{
        --nm-bg:#151713;
        --nm-panel:#22251f;
        --nm-panel-2:#2c3028;
        --nm-border:#8f9a7a;
        --nm-bone:#e6dfcf;
        --nm-muted:#b9b19f;
        --nm-accent:#78a84f;
        --nm-accent-strong:#9fd66d;
        --nm-danger:#8f3d3d;
        --nm-select:#f3eddf;
        background:
          radial-gradient(circle at top right, rgba(120,168,79,.12), transparent 34%),
          linear-gradient(180deg, #181a16, #11130f) !important;
        color:var(--nm-bone) !important;
      }

      .necromancer-manager-root .window-content *,
      .necromancer-manager-root .window-content h1,
      .necromancer-manager-root .window-content h2,
      .necromancer-manager-root .window-content h3,
      .necromancer-manager-root .window-content h4,
      .necromancer-manager-root .window-content p,
      .necromancer-manager-root .window-content label,
      .necromancer-manager-root .window-content td,
      .necromancer-manager-root .window-content th{
        color:var(--nm-bone) !important;
        -webkit-text-fill-color:currentColor !important;
        text-shadow:none !important;
      }

      .necromancer-manager-root .hm-card,
      .necromancer-manager-root .hm-toolbar,
      .necromancer-manager-root .hm-tabs,
      .necromancer-manager-root .hm-tab-shell,
      .necromancer-manager-root .hm-section-tabs,
      .necromancer-manager-root .hm-roll-mode label,
      .necromancer-manager-root .hm-attack-modifier,
      .necromancer-manager-root .nm-setup-block{
        background:linear-gradient(180deg,var(--nm-panel-2),var(--nm-panel)) !important;
        border:1px solid var(--nm-border) !important;
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.03),0 4px 12px rgba(0,0,0,.35) !important;
      }

      .necromancer-manager-root .hm-head{
        background:linear-gradient(90deg,rgba(120,168,79,.22),rgba(230,223,207,.06)) !important;
        border:1px solid var(--nm-border) !important;
      }

      .necromancer-manager-root button{
        color:var(--nm-bone) !important;
        background:linear-gradient(180deg,#373c31,#242820) !important;
        border:1px solid var(--nm-border) !important;
      }

      .necromancer-manager-root button:hover,
      .necromancer-manager-root button:focus{
        color:#fff !important;
        border-color:var(--nm-accent-strong) !important;
        box-shadow:0 0 7px rgba(159,214,109,.45) !important;
      }

      .necromancer-manager-root .nm-main-tab.is-active,
      .necromancer-manager-root .hm-tab-shell.is-active,
      .necromancer-manager-root .hm-section-tab.is-active{
        background:linear-gradient(180deg,#5c7a42,#374d2b) !important;
        border-color:var(--nm-accent-strong) !important;
      }

      .necromancer-manager-root .window-content select,
      .necromancer-manager-root .window-content select option{
        color:#111 !important;
        -webkit-text-fill-color:#111 !important;
        background:var(--nm-select) !important;
      }

      .necromancer-manager-root .window-content input,
      .necromancer-manager-root .window-content textarea{
        color:var(--nm-bone) !important;
        background:#181b16 !important;
        border:1px solid var(--nm-border) !important;
      }

      .necromancer-manager-root .hm-table th{
        background:#1d211b !important;
      }

      .necromancer-manager-root .hm-table tbody tr:nth-child(odd){
        background:rgba(255,255,255,.025) !important;
      }

      .necromancer-manager-root .hm-table tbody tr:hover{
        background:rgba(120,168,79,.11) !important;
      }

      .necromancer-manager-root .nm-danger-note{
        color:#efb0b0 !important;
        margin-top:8px;
      }

      .necromancer-manager-root .nm-delete-grid{
        display:grid;
        grid-template-columns:max-content minmax(150px,1fr) 105px;
        gap:8px;
        align-items:center;
      }

      .necromancer-manager-root .nm-delete-label{
        font-weight:800;
        white-space:nowrap;
      }

      .necromancer-manager-root .nm-delete-grid select{
        height:30px !important;
        width:100%;
      }

      .necromancer-manager-root .nm-delete-grid button{
        width:105px !important;
        min-width:105px !important;
        height:30px !important;
        margin:0 !important;
        padding:0 8px !important;
        background:linear-gradient(180deg,#713838,#4d2525) !important;
        border-color:#b36d6d !important;
        font-size:12px !important;
      }

      /* Les onglets de groupes restent sur une seule ligne et se compressent. */
      .necromancer-manager-root .hm-tabs{
        display:flex !important;
        flex-wrap:nowrap !important;
        gap:4px !important;
        overflow:hidden !important;
      }

      .necromancer-manager-root .hm-tab-shell{
        flex:1 1 0 !important;
        min-width:0 !important;
        grid-template-columns:minmax(0,1fr) 26px !important;
      }

      .necromancer-manager-root .hm-tab{
        min-width:0 !important;
        padding:0 4px !important;
        font-size:clamp(9px,1vw,13px) !important;
      }

      .necromancer-manager-root .hm-tab-label{
        overflow:hidden !important;
        text-overflow:ellipsis !important;
        white-space:nowrap !important;
      }

      .necromancer-manager-root .hm-tab-rename{
        width:26px !important;
        min-width:26px !important;
      }

      @media (max-width:650px){
        .necromancer-manager-root .nm-delete-grid{
          grid-template-columns:1fr;
        }
        .necromancer-manager-root .nm-delete-grid button{
          width:100% !important;
          min-width:0 !important;
        }
      }


      /* Listes déroulantes : priorité maximale sur le thème D&D5e/Foundry. */
      .necromancer-manager-root select,
      .necromancer-manager-root select.sk-pa-feature,
      .necromancer-manager-root select[name="nmSourceActor"],
      .necromancer-manager-root select[name="nmTargetGroup"],
      .necromancer-manager-root select[name="nmDeleteGroup"]{
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        background-color:#f4eedf !important;
        background-image:none !important;
        border:1px solid #8c816d !important;
        text-shadow:none !important;
        opacity:1 !important;
      }

      .necromancer-manager-root select option,
      .necromancer-manager-root select.sk-pa-feature option,
      .necromancer-manager-root select[name="nmSourceActor"] option,
      .necromancer-manager-root select[name="nmTargetGroup"] option,
      .necromancer-manager-root select[name="nmDeleteGroup"] option{
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        background-color:#f4eedf !important;
        text-shadow:none !important;
      }

      .necromancer-manager-root select option:checked,
      .necromancer-manager-root select option:hover{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background-color:#526b3c !important;
      }


      /* === Thème clair classique === */
      .necromancer-manager-root{
        --nm-bg:#d9d9d9;
        --nm-panel:#ffffff;
        --nm-panel-alt:#ece8dd;
        --nm-border:#9a958a;
        --nm-text:#161616;
        --nm-muted:#555555;
        --nm-button:#ffffff;
        --nm-button-hover:#e7e2d6;
        --nm-active:#d8d2c4;
        --nm-danger:#b23a3a;
        color:var(--nm-text) !important;
        background:#d9d9d9 !important;
      }

      .necromancer-manager-root,
      .necromancer-manager-root *,
      .necromancer-manager-root h1,
      .necromancer-manager-root h2,
      .necromancer-manager-root h3,
      .necromancer-manager-root h4,
      .necromancer-manager-root p,
      .necromancer-manager-root label,
      .necromancer-manager-root span,
      .necromancer-manager-root td,
      .necromancer-manager-root th,
      .necromancer-manager-root a{
        color:var(--nm-text) !important;
        -webkit-text-fill-color:var(--nm-text) !important;
        text-shadow:none !important;
      }

      .necromancer-manager-root .hm-card,
      .necromancer-manager-root .hm-toolbar,
      .necromancer-manager-root .hm-tabs,
      .necromancer-manager-root .hm-tab-shell,
      .necromancer-manager-root .hm-section-tabs,
      .necromancer-manager-root .hm-roll-mode label,
      .necromancer-manager-root .hm-attack-modifier,
      .necromancer-manager-root .nm-setup-block,
      .necromancer-manager-root .hm-check,
      .necromancer-manager-root .hm-check-btn{
        background:var(--nm-panel) !important;
        border:1px solid var(--nm-border) !important;
        box-shadow:none !important;
      }

      .necromancer-manager-root .hm-head,
      .necromancer-manager-root .hm-table th{
        background:var(--nm-panel-alt) !important;
        border-color:var(--nm-border) !important;
        box-shadow:none !important;
      }

      .necromancer-manager-root button,
      .necromancer-manager-root .hm-mini-btn,
      .necromancer-manager-root .hm-check-btn,
      .necromancer-manager-root .btn-active-initiative,
      .necromancer-manager-root .btn-copy-feature,
      .necromancer-manager-root .btn-active-attack,
      .necromancer-manager-root .btn-sk-launch,
      .necromancer-manager-root .btn-apply,
      .necromancer-manager-root .btn-rez,
      .necromancer-manager-root .btn-send-flappy,
      .btn-return-active{
        color:var(--nm-text) !important;
        -webkit-text-fill-color:var(--nm-text) !important;
        background:var(--nm-button) !important;
        border:1px solid var(--nm-border) !important;
        box-shadow:none !important;
        text-shadow:none !important;
      }

      .necromancer-manager-root button:hover,
      .necromancer-manager-root button:focus{
        color:var(--nm-text) !important;
        -webkit-text-fill-color:var(--nm-text) !important;
        background:var(--nm-button-hover) !important;
        border-color:#5f5a50 !important;
        box-shadow:none !important;
      }

      .necromancer-manager-root .nm-main-tab.is-active,
      .necromancer-manager-root .hm-tab-shell.is-active,
      .necromancer-manager-root .hm-section-tab.is-active{
        color:var(--nm-text) !important;
        -webkit-text-fill-color:var(--nm-text) !important;
        background:var(--nm-active) !important;
        border-color:#5f5a50 !important;
      }

      .necromancer-manager-root input,
      .necromancer-manager-root textarea{
        color:var(--nm-text) !important;
        -webkit-text-fill-color:var(--nm-text) !important;
        background:#ffffff !important;
        border:1px solid var(--nm-border) !important;
      }

      .necromancer-manager-root select,
      .necromancer-manager-root select.sk-pa-feature,
      .necromancer-manager-root select[name="nmSourceActor"],
      .necromancer-manager-root select[name="nmTargetGroup"],
      .necromancer-manager-root select[name="nmDeleteGroup"]{
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        background:#ffffff !important;
        background-color:#ffffff !important;
        background-image:none !important;
        border:1px solid var(--nm-border) !important;
        text-shadow:none !important;
        opacity:1 !important;
      }

      .necromancer-manager-root select option,
      .necromancer-manager-root select.sk-pa-feature option,
      .necromancer-manager-root select[name="nmSourceActor"] option,
      .necromancer-manager-root select[name="nmTargetGroup"] option,
      .necromancer-manager-root select[name="nmDeleteGroup"] option{
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        background:#ffffff !important;
        background-color:#ffffff !important;
      }

      .necromancer-manager-root select option:checked{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#666666 !important;
      }

      .necromancer-manager-root .hm-table,
      .necromancer-manager-root .hm-table td,
      .necromancer-manager-root .hm-table th{
        border-color:var(--nm-border) !important;
      }

      .necromancer-manager-root .hm-table tbody tr:nth-child(odd){
        background:#fafafa !important;
      }

      .necromancer-manager-root .hm-table tbody tr:hover{
        background:#eeeae1 !important;
      }

      .necromancer-manager-root .hm-table tbody tr:has(input.sk-check-any:checked){
        background:#ddd8cc !important;
        box-shadow:inset 3px 0 0 #777166 !important;
      }

      .necromancer-manager-root .nm-delete-grid button{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:var(--nm-danger) !important;
        border-color:#7d2525 !important;
      }

      .necromancer-manager-root .nm-delete-grid button:hover{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#932e2e !important;
      }

      .necromancer-manager-root .nm-danger-note{
        color:#8a2020 !important;
        -webkit-text-fill-color:#8a2020 !important;
      }


      /* Correction définitive des listes natives Chromium/Foundry. */
      .necromancer-manager-root,
      .necromancer-manager-root .nm-readable-select{
        color-scheme:light !important;
      }

      .necromancer-manager-root select.nm-readable-select,
      .necromancer-manager-root select.sk-pa-feature,
      .necromancer-manager-root select[name="nmSourceActor"],
      .necromancer-manager-root select[name="nmTargetGroup"],
      .necromancer-manager-root select[name="nmDeleteGroup"]{
        appearance:auto !important;
        -webkit-appearance:menulist !important;
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        background-color:#ffffff !important;
        background:#ffffff !important;
        border:1px solid #8d8d8d !important;
        text-shadow:none !important;
        opacity:1 !important;
        filter:none !important;
      }

      .necromancer-manager-root select.nm-readable-select option,
      .necromancer-manager-root select.sk-pa-feature option,
      .necromancer-manager-root select[name="nmSourceActor"] option,
      .necromancer-manager-root select[name="nmTargetGroup"] option,
      .necromancer-manager-root select[name="nmDeleteGroup"] option{
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        background-color:#ffffff !important;
        background:#ffffff !important;
        text-shadow:none !important;
        opacity:1 !important;
      }

      .necromancer-manager-root select.nm-readable-select option:checked,
      .necromancer-manager-root select.sk-pa-feature option:checked{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background-color:#276fd1 !important;
        background:#276fd1 !important;
      }


      .necromancer-manager-root button,
      .necromancer-manager-root select,
      .necromancer-manager-root input[type="text"],
      .necromancer-manager-root input[type="number"]{
        border:1px solid #000000 !important;
      }


      .necromancer-manager-root .nm-management-content{
        display:flex;
        flex-direction:column;
        gap:8px;
      }

      .necromancer-manager-root .nm-action-block{
        display:block !important;
        padding:14px 16px !important;
      }

      .necromancer-manager-root .nm-action-block > h4{
        margin:0 0 12px 0 !important;
        padding:0 0 8px 0 !important;
        border-bottom:1px solid #9aa0a8 !important;
      }

      .necromancer-manager-root .nm-action-row{
        display:grid !important;
        grid-template-columns:minmax(0,1fr) 180px !important;
        gap:14px !important;
        align-items:end !important;
      }

      .necromancer-manager-root .nm-action-description{
        margin:0 !important;
        align-self:center !important;
      }

      .necromancer-manager-root .nm-management-button{
        width:180px !important;
        min-width:180px !important;
        height:38px !important;
        margin:0 !important;
        padding:0 10px !important;
        box-sizing:border-box !important;
        align-self:end !important;
      }

      .necromancer-manager-root .nm-import-grid{
        display:grid !important;
        grid-template-columns:1.55fr 105px 1.4fr !important;
        gap:12px !important;
        align-items:end !important;
        min-width:0 !important;
      }

      .necromancer-manager-root .nm-import-grid label{
        min-width:0 !important;
      }

      .necromancer-manager-root .nm-import-grid select,
      .necromancer-manager-root .nm-import-grid input{
        width:100% !important;
        height:38px !important;
        box-sizing:border-box !important;
      }

      .necromancer-manager-root .nm-delete-grid{
        display:grid !important;
        grid-template-columns:max-content minmax(0,1fr) !important;
        gap:12px !important;
        align-items:center !important;
        min-width:0 !important;
      }

      .necromancer-manager-root .nm-delete-grid select{
        width:100% !important;
        height:38px !important;
        box-sizing:border-box !important;
      }

      .necromancer-manager-root .nm-danger-note{
        margin:10px 0 0 0 !important;
      }

      @media (max-width:900px){
        .necromancer-manager-root .nm-action-row{
          grid-template-columns:1fr !important;
        }

        .necromancer-manager-root .nm-management-button{
          width:100% !important;
          min-width:0 !important;
        }
      }

      @media (max-width:700px){
        .necromancer-manager-root .nm-import-grid{
          grid-template-columns:1fr !important;
        }

        .necromancer-manager-root .nm-delete-grid{
          grid-template-columns:1fr !important;
        }
      }


      .necromancer-manager-root .hm-ops{
        display:grid !important;
        grid-template-columns:minmax(180px,260px) minmax(220px,300px) !important;
        justify-content:center !important;
        gap:14px !important;
      }

      .necromancer-manager-root .hm-ops .hm-field{
        text-align:center !important;
      }

      .necromancer-manager-root .hm-ops .hm-field .lbl{
        text-align:center !important;
      }

      @media (max-width:700px){
        .necromancer-manager-root .hm-ops{
          grid-template-columns:1fr !important;
        }
      }


      /* === Thème sombre lisible === */
      .necromancer-manager-root{
        --nm-page:#3b3e42;
        --nm-panel:#50545a;
        --nm-panel-alt:#5d6269;
        --nm-border:#1d1f22;
        --nm-text:#f5f5f2;
        --nm-muted:#d6d7d8;
        --nm-button:#e7e7e4;
        --nm-button-hover:#ffffff;
        --nm-button-text:#151515;
        --nm-field:#f6f3ea;
        --nm-field-text:#111111;
        --nm-active:#7d8792;
        --nm-danger:#a53d3d;

        background:var(--nm-page) !important;
        color:var(--nm-text) !important;
      }

      .necromancer-manager-root,
      .necromancer-manager-root h1,
      .necromancer-manager-root h2,
      .necromancer-manager-root h3,
      .necromancer-manager-root h4,
      .necromancer-manager-root p,
      .necromancer-manager-root label,
      .necromancer-manager-root span,
      .necromancer-manager-root td,
      .necromancer-manager-root th,
      .necromancer-manager-root a,
      .necromancer-manager-root .lbl,
      .necromancer-manager-root .hm-toolbar-title{
        color:var(--nm-text) !important;
        -webkit-text-fill-color:var(--nm-text) !important;
        text-shadow:none !important;
      }

      .necromancer-manager-root .hm-card,
      .necromancer-manager-root .hm-toolbar,
      .necromancer-manager-root .hm-tabs,
      .necromancer-manager-root .hm-tab-shell,
      .necromancer-manager-root .hm-section-tabs,
      .necromancer-manager-root .hm-roll-mode label,
      .necromancer-manager-root .hm-attack-modifier,
      .necromancer-manager-root .nm-setup-block,
      .necromancer-manager-root .hm-check{
        background:var(--nm-panel) !important;
        border:1px solid var(--nm-border) !important;
        box-shadow:none !important;
      }

      .necromancer-manager-root .hm-head,
      .necromancer-manager-root .hm-table th{
        background:var(--nm-panel-alt) !important;
        border-color:var(--nm-border) !important;
      }

      .necromancer-manager-root .nm-main-tabs{
        background:#2f3236 !important;
        border:1px solid #111315 !important;
      }

      .necromancer-manager-root button,
      .necromancer-manager-root .hm-mini-btn,
      .necromancer-manager-root .hm-check-btn,
      .necromancer-manager-root .btn-active-initiative,
      .necromancer-manager-root .btn-copy-feature,
      .necromancer-manager-root .btn-active-attack,
      .necromancer-manager-root .btn-sk-launch,
      .necromancer-manager-root .btn-apply,
      .necromancer-manager-root .btn-reset-temp,
      .necromancer-manager-root .btn-close,
      .necromancer-manager-root .btn-rez,
      .necromancer-manager-root .btn-send-flappy,
      .btn-return-active{
        color:var(--nm-button-text) !important;
        -webkit-text-fill-color:var(--nm-button-text) !important;
        background:var(--nm-button) !important;
        border:1px solid #111111 !important;
        text-shadow:none !important;
        box-shadow:none !important;
      }

      .necromancer-manager-root button:hover,
      .necromancer-manager-root button:focus{
        color:#000000 !important;
        -webkit-text-fill-color:#000000 !important;
        background:var(--nm-button-hover) !important;
        border-color:#000000 !important;
        box-shadow:0 0 0 2px rgba(255,255,255,.22) !important;
      }

      .necromancer-manager-root .nm-main-tab.is-active,
      .necromancer-manager-root .hm-tab-shell.is-active,
      .necromancer-manager-root .hm-section-tab.is-active{
        background:var(--nm-active) !important;
        border-color:#111111 !important;
      }

      .necromancer-manager-root .nm-main-tab.is-active,
      .necromancer-manager-root .nm-main-tab.is-active *,
      .necromancer-manager-root .hm-tab-shell.is-active,
      .necromancer-manager-root .hm-tab-shell.is-active *,
      .necromancer-manager-root .hm-section-tab.is-active,
      .necromancer-manager-root .hm-section-tab.is-active *{
        color:#000000 !important;
        -webkit-text-fill-color:#000000 !important;
        text-shadow:none !important;
      }

      .necromancer-manager-root input,
      .necromancer-manager-root textarea,
      .necromancer-manager-root select,
      .necromancer-manager-root select.sk-pa-feature,
      .necromancer-manager-root select[name="nmSourceActor"],
      .necromancer-manager-root select[name="nmTargetGroup"],
      .necromancer-manager-root select[name="nmDeleteGroup"]{
        color:var(--nm-field-text) !important;
        -webkit-text-fill-color:var(--nm-field-text) !important;
        background:var(--nm-field) !important;
        background-color:var(--nm-field) !important;
        border:1px solid #111111 !important;
        text-shadow:none !important;
        opacity:1 !important;
      }

      .necromancer-manager-root select option,
      .necromancer-manager-root select.sk-pa-feature option,
      .necromancer-manager-root select[name="nmSourceActor"] option,
      .necromancer-manager-root select[name="nmTargetGroup"] option,
      .necromancer-manager-root select[name="nmDeleteGroup"] option{
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        background:#f6f3ea !important;
        background-color:#f6f3ea !important;
      }

      .necromancer-manager-root select option:checked{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#3f6fa8 !important;
      }

      .necromancer-manager-root .hm-table{
        background:#45494e !important;
        border-color:#181a1c !important;
      }

      .necromancer-manager-root .hm-table td,
      .necromancer-manager-root .hm-table th{
        border-color:#24272a !important;
      }

      .necromancer-manager-root .hm-table tbody tr:nth-child(odd){
        background:#494d52 !important;
      }

      .necromancer-manager-root .hm-table tbody tr:nth-child(even){
        background:#41454a !important;
      }

      .necromancer-manager-root .hm-table tbody tr:hover{
        background:#646a71 !important;
      }

      .necromancer-manager-root .hm-table tbody tr:has(input.sk-check-any:checked){
        background:#6e7780 !important;
        box-shadow:inset 4px 0 0 #ffffff !important;
      }

      .necromancer-manager-root .nm-delete-grid button{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:var(--nm-danger) !important;
        border-color:#561d1d !important;
      }

      .necromancer-manager-root .nm-delete-grid button:hover{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#c04b4b !important;
      }

      .necromancer-manager-root .nm-danger-note{
        color:#ffd0d0 !important;
        -webkit-text-fill-color:#ffd0d0 !important;
      }

      .necromancer-manager-root input[type="radio"],
      .necromancer-manager-root input[type="checkbox"]{
        accent-color:#ffffff;
      }


      /* === Thème Foundry sombre lisible === */
      .necromancer-manager-root{
        --nm-page:#2b2d31;
        --nm-panel:#3a3d42;
        --nm-panel-alt:#34373c;
        --nm-tabs:#202225;
        --nm-text:#e8e8e8;
        --nm-button:#d8d8d8;
        --nm-button-text:#111111;
        --nm-field:#f5f2ea;
        --nm-field-text:#111111;
        --nm-active:#4d5560;
        --nm-danger:#8f3a3a;
      }

      .necromancer-manager-root{
        background:var(--nm-page)!important;
        color:var(--nm-text)!important;
      }

      .necromancer-manager-root,
      .necromancer-manager-root *{
        color:var(--nm-text)!important;
        text-shadow:none!important;
      }

      .necromancer-manager-root .hm-card,
      .necromancer-manager-root .hm-toolbar,
      .necromancer-manager-root .hm-tab-shell,
      .necromancer-manager-root .hm-section-tabs,
      .necromancer-manager-root .nm-setup-block{
        background:var(--nm-panel)!important;
        border:1px solid #111!important;
      }

      .necromancer-manager-root .nm-main-tabs{
        background:var(--nm-tabs)!important;
        border:1px solid #111!important;
      }

      .necromancer-manager-root button,
      .necromancer-manager-root .hm-mini-btn{
        background:var(--nm-button)!important;
        color:var(--nm-button-text)!important;
        border:1px solid #000!important;
      }

      .necromancer-manager-root button:hover{
        background:#ffffff!important;
      }

      .necromancer-manager-root select,
      .necromancer-manager-root input,
      .necromancer-manager-root textarea{
        background:var(--nm-field)!important;
        color:var(--nm-field-text)!important;
        border:1px solid #000!important;
      }

      .necromancer-manager-root select option{
        background:var(--nm-field)!important;
        color:#111!important;
      }

      .necromancer-manager-root .hm-table tbody tr:nth-child(odd){
        background:#34373c!important;
      }

      .necromancer-manager-root .hm-table tbody tr:nth-child(even){
        background:#3a3d42!important;
      }

      .necromancer-manager-root .hm-table tbody tr:hover{
        background:#4d5560!important;
      }

      .necromancer-manager-root .nm-delete-grid button{
        background:var(--nm-danger)!important;
        color:#fff!important;
      }


      /* === Dark White Theme Override === */
      .necromancer-manager-root{
        --nm-page:#2b2d31;
        --nm-panel:#3a3d42;
        --nm-tabs:#202225;
      }

      .necromancer-manager-root,
      .necromancer-manager-root *{
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
      }

      .necromancer-manager-root{
        background:#2b2d31 !important;
      }

      .necromancer-manager-root .hm-card,
      .necromancer-manager-root .hm-toolbar,
      .necromancer-manager-root .hm-tab-shell,
      .necromancer-manager-root .hm-section-tabs,
      .necromancer-manager-root .nm-setup-block{
        background:#3a3d42 !important;
        border:1px solid #6f7782 !important;
      }

      .necromancer-manager-root .nm-main-tabs{
        background:#202225 !important;
        border:1px solid #6f7782 !important;
      }

      .necromancer-manager-root button,
      .necromancer-manager-root .hm-mini-btn{
        background:#202225 !important;
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        border:1px solid #6f7782 !important;
      }

      .necromancer-manager-root button:hover{
        background:#4d5560 !important;
      }

      .necromancer-manager-root .nm-main-tab.is-active,
      .necromancer-manager-root .hm-tab-shell.is-active,
      .necromancer-manager-root .hm-section-tab.is-active{
        background:#58657a !important;
      }

      .necromancer-manager-root select,
      .necromancer-manager-root input,
      .necromancer-manager-root textarea{
        background:#202225 !important;
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        border:1px solid #6f7782 !important;
      }

      .necromancer-manager-root select option{
        background:#202225 !important;
        color:#ffffff !important;
      }

      .necromancer-manager-root .nm-delete-grid button{
        background:#8f3a3a !important;
        color:#ffffff !important;
      }





      /* === Uniformisation finale des boutons : blanc / texte noir === */
      .necromancer-manager-root button,
      .necromancer-manager-root .hm-mini-btn,
      .necromancer-manager-root .hm-check-btn,
      .necromancer-manager-root .nm-main-tab,
      .necromancer-manager-root .hm-section-tab,
      .necromancer-manager-root .hm-tab,
      .necromancer-manager-root .hm-tab-rename{
        background:#ffffff !important;
        color:#111111 !important;
        -webkit-text-fill-color:#111111 !important;
        border:1px solid #8b8f96 !important;
        box-shadow:none !important;
        text-shadow:none !important;
      }

      .necromancer-manager-root button i,
      .necromancer-manager-root button span{
        color:inherit !important;
        -webkit-text-fill-color:inherit !important;
      }

      .necromancer-manager-root button:hover:not(:disabled),
      .necromancer-manager-root button:focus-visible:not(:disabled),
      .necromancer-manager-root .hm-mini-btn:hover:not(:disabled),
      .necromancer-manager-root .hm-check-btn:hover:not(:disabled){
        background:#e8e8e8 !important;
        color:#000000 !important;
        -webkit-text-fill-color:#000000 !important;
        border-color:#444950 !important;
        box-shadow:0 0 0 1px rgba(255,255,255,.32) !important;
      }

      .necromancer-manager-root .nm-main-tab.is-active,
      .necromancer-manager-root .hm-tab-shell.is-active,
      .necromancer-manager-root .hm-section-tab.is-active,
      .necromancer-manager-root .hm-tab.is-active{
        background:#ffffff !important;
        color:#000000 !important;
        -webkit-text-fill-color:#000000 !important;
        border-color:#111111 !important;
        box-shadow:inset 0 -3px 0 #111111 !important;
      }

      .necromancer-manager-root button:disabled{
        background:#d1d1d1 !important;
        color:#6b6b6b !important;
        -webkit-text-fill-color:#6b6b6b !important;
        border-color:#8f8f8f !important;
        opacity:.65 !important;
        cursor:not-allowed !important;
      }

      /* Les actions destructrices restent visuellement distinctes. */
      .necromancer-manager-root .btn-delete-group,
      .necromancer-manager-root .nm-delete-grid button{
        background:#8f3a3a !important;
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        border-color:#b96060 !important;
      }

      .necromancer-manager-root .btn-delete-group:hover:not(:disabled),
      .necromancer-manager-root .nm-delete-grid button:hover:not(:disabled){
        background:#a94747 !important;
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        border-color:#e08a8a !important;
      }

      .necromancer-manager-root .nm-user-toolbar{
        display:flex;
        flex:0 1 360px;
        min-width:210px;
        max-width:360px;
        align-items:center;
        gap:6px;
        margin:0;
        padding:0;
        background:transparent;
        border:0;
      }

      .necromancer-manager-root .nm-user-toolbar label{
        flex:0 0 auto;
        margin:0;
        font-weight:700;
        white-space:nowrap;
      }

      .necromancer-manager-root .nm-user-toolbar select{
        flex:1 1 auto;
        min-width:0;
        height:30px !important;
      }
      /* Composant partagé : toutes les listes de Necromancer Manager. */
      .necromancer-manager-root .nm-select,
      .necromancer-manager-root .nm-select:hover,
      .necromancer-manager-root .nm-select:focus,
      .necromancer-manager-root .nm-select:active {
        appearance:none !important;
        -webkit-appearance:none !important;
        color-scheme:dark !important;
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background-color:#2b2f36 !important;
        border:1px solid #555b66 !important;
        border-radius:12px !important;
        box-shadow:none !important;
        text-shadow:none !important;
        font-weight:700 !important;
        padding-right:30px !important;
        background-image:linear-gradient(45deg, transparent 50%, #ffffff 50%), linear-gradient(135deg, #ffffff 50%, transparent 50%) !important;
        background-position:calc(100% - 15px) 50%, calc(100% - 10px) 50% !important;
        background-size:5px 5px, 5px 5px !important;
        background-repeat:no-repeat !important;
        opacity:1 !important;
        filter:none !important;
      }
      .necromancer-manager-root .nm-select option,
      .necromancer-manager-root .nm-select optgroup {
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#1f1f1f !important;
        text-shadow:none !important;
        text-align:left !important;
      }
      .necromancer-manager-root .nm-select option:checked {
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#276fd1 !important;
      }

      /* Composant factorisé final : une seule apparence pour toutes les listes. */
      html body .necromancer-manager-root select.nm-select,
      html body .necromancer-manager-root select.nm-select:hover,
      html body .necromancer-manager-root select.nm-select:focus,
      html body .necromancer-manager-root select.nm-select:active {
        appearance:none !important;
        -webkit-appearance:none !important;
        color-scheme:dark !important;
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background-color:#2b2f36 !important;
        border:1px solid #555b66 !important;
        border-radius:12px !important;
        box-shadow:none !important;
        text-shadow:none !important;
        font-weight:700 !important;
        padding-right:30px !important;
        background-image:linear-gradient(45deg, transparent 50%, #ffffff 50%), linear-gradient(135deg, #ffffff 50%, transparent 50%) !important;
        background-position:calc(100% - 15px) 50%, calc(100% - 10px) 50% !important;
        background-size:5px 5px, 5px 5px !important;
        background-repeat:no-repeat !important;
        opacity:1 !important;
        filter:none !important;
      }
      html body .necromancer-manager-root select.nm-select option,
      html body .necromancer-manager-root select.nm-select optgroup {
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#1f1f1f !important;
      }
      html body .necromancer-manager-root select.nm-select option:checked {
        color:#ffffff !important;
        -webkit-text-fill-color:#ffffff !important;
        background:#276fd1 !important;
      }
          </style>

    <div class="necromancer-manager-root">
    <div class="nm-top-toolbar">
      ${game.user.isGM ? `
        <div class="nm-user-toolbar">
          <label for="nm-user-selector"><i class="fas fa-users"></i> Utilisateur</label>
          <select id="nm-user-selector" name="nmUserSelector" class="nm-select">${userOptionsHTML()}</select>
        </div>
      ` : ""}
      <div class="nm-main-tabs" role="tablist">
        <button type="button" class="nm-main-tab is-active" data-main-section="combat">
          <i class="fas fa-skull"></i> Horde
        </button>
        ${canAccessSetup ? `<button type="button" class="nm-main-tab" data-main-section="setup">
          <i class="fas fa-cog"></i> Groupes
        </button>` : ""}
      </div>
    </div>

    ${canAccessSetup ? `<section class="nm-main-section" data-main-section="setup">
      <div class="hm-card nm-group-manager">
        <div class="hm-head">
          <h3>Groupes et créatures — ${escapeHTML(targetUser.name)}</h3>
        </div>

        <div class="nm-management-content">
          ${canCreateGroup ? `<div class="nm-setup-block nm-action-block">
            <h4>1. Créer un groupe</h4>
            <div class="nm-action-row">
              <p class="nm-action-description">Crée un groupe Foundry et son dossier dans NecromancerManager.</p>
              <button type="button" class="hm-mini-btn nm-management-button btn-create-group">
                <i class="fas fa-plus"></i> Créer un groupe
              </button>
            </div>
          </div>` : ""}

          ${canAddCreature ? `<div class="nm-setup-block nm-action-block">
            <h4>2. Ajouter au groupe</h4>
            <div class="nm-action-row nm-action-row-fields">
              <div class="nm-import-grid">
                <label><span>Créature source</span><select class="nm-select nm-horde-select" name="nmSourceActor">${actorOptionsHTML()}</select></label>
                <label><span>Quantité</span><input type="number" name="nmQuantity" value="1" min="1" max="100" step="1"></label>
                <label><span>Groupe cible</span><select class="nm-select nm-horde-select" name="nmTargetGroup">${groupOptionsHTML()}</select></label>
              </div>
              <button type="button" class="hm-mini-btn nm-management-button btn-add-creature" ${GROUPS.length ? "" : "disabled"}>
                <i class="fas fa-user-plus"></i> Créer et ajouter
              </button>
            </div>
          </div>` : ""}

          ${canAddCreature ? `<div class="nm-setup-block nm-action-block">
            <h4>3. Token de groupe</h4>
            <div class="nm-action-row nm-action-row-token">
              <div class="nm-delete-grid">
                <span class="nm-delete-label">Groupe</span>
                <select class="nm-select nm-horde-select" name="nmTokenGroup">${groupOptionsHTML()}</select>
              </div>
              <button type="button" class="hm-mini-btn nm-management-button btn-sync-group-token" ${GROUPS.length ? "" : "disabled"}>
                <i class="fas fa-chess-pawn"></i> Créer / mettre à jour
              </button>
            </div>
            <p class="nm-action-description">Le nom ainsi que le nombre d’entités actives apparaissent au survol pour tous les utilisateurs, et la taille s’adapte automatiquement au nombre d’entités actives dans le groupe.</p>
          </div>` : ""}

          ${canDeleteGroup ? `<div class="nm-setup-block nm-action-block">
            <h4>4. Supprimer un groupe</h4>
            <div class="nm-action-row nm-action-row-delete">
              <div class="nm-delete-grid">
                <span class="nm-delete-label">Groupe à supprimer</span>
                <select class="nm-select nm-horde-select" name="nmDeleteGroup">${groupOptionsHTML()}</select>
              </div>
              <button type="button" class="hm-mini-btn nm-management-button btn-delete-group" ${GROUPS.length ? "" : "disabled"}>
                <i class="fas fa-trash"></i> Supprimer
              </button>
            </div>
            <p class="nm-danger-note">
              Cette action supprime le groupe, son dossier et toutes les créatures qu'il contient.
            </p>
          </div>` : ""}
        </div>

        <div class="nm-setup-block nm-help-block">
          <h4>Fonctionnement de Necromancer Manager</h4>

          <h5>Horde</h5>
          <p>Chaque onglet correspond à un groupe. Les créatures sont classées automatiquement selon leur état.</p>
          <ul>
            <li><strong>Squelettes :</strong> créatures actives. Cochez celles concernées avant d’utiliser une action ou un outil de PV.</li>
            <li><strong>Caractéristiques :</strong> lance un test de caractéristique ou un jet de sauvegarde pour les squelettes cochés.</li>
            <li><strong>0 PV :</strong> créatures mortes. <strong>Rez sélection</strong> les renvoie parmi les squelettes actifs.</li>
            <li><strong>FlappyBall :</strong> réserve temporaire hors de la horde active. Le bouton de retour replace les créatures cochées dans Squelettes.</li>
            <li><strong>Custom :</strong> simule plusieurs attaques avec une formule de dégâts, un bonus de touche et une plage de CA.</li>
          </ul>

          <h5>Actions et jets</h5>
          <ul>
            <li><strong>Initiative :</strong> lance une initiative individuelle pour chaque squelette coché et calcule leur moyenne. Si le token de groupe associé est déjà présent dans le combat, son initiative est mise à jour automatiquement. Sinon, le MJ doit reporter manuellement la moyenne dans le Combat Tracker.</li>
            <li><strong>Copier action :</strong> copie sur les créatures sélectionnées la dernière action modifiée.</li>
            <li><strong>Attaque :</strong> lance l’action sélectionnée pour chaque créature cochée, avec le mode normal, avantage ou désavantage et le bonus/malus indiqué.</li>
            <li><strong>Voir les jets :</strong> apparaît dans le chat après le lancement d’une attaque et permet de déplier le détail des jets individuels.</li>
          </ul>

          <h5>Gestion des PV</h5>
          <ul>
            <li><strong>Appliquer :</strong> applique la valeur saisie aux créatures cochées. Une valeur positive ajoute des PV ou des PV temporaires ; une valeur négative en retire.</li>
            <li><strong>Reset PV temp :</strong> remet leurs PV temporaires à zéro.</li>
            <li><strong>Envoyer vers FlappyBall :</strong> déplace les créatures cochées dans le menu FlappyBall.</li>
            <li>Une créature à 0 PV passe automatiquement dans l’onglet 0 PV. Sa résurrection la replace dans Squelettes.</li>
          </ul>

          <h5>Groupes</h5>
          <ul>
            <li><strong>Créer un groupe :</strong> crée une entité <em>Groupe</em> dans les Acteurs Foundry ainsi que la structure de dossiers <code>NecromancerManager / NomJoueur / NomGroupe</code>.</li>
            <li><strong>Bouton crayon à côté du nom du groupe :</strong> renomme simultanément le dossier, l’entité Groupe et le token de groupe associé.</li>
            <li><strong>Créer et ajouter :</strong> crée les exemplaires de la créature source dans le groupe choisi. La liste des créatures sources provient du dossier Foundry <code>Creatures</code>, normalement créé par le module Plutonium lors de l’import de créatures. La numérotation continue à partir des créatures déjà présentes.</li>
            <li><strong>Créer / mettre à jour :</strong> crée ou synchronise l’Actor servant de token de groupe.</li>
            <li><strong>Supprimer :</strong> supprime le groupe, son dossier et les créatures qu’il contient.</li>
          </ul>

          <h5>Token de groupe</h5>
          <p>Le token représente la horde sur la scène. Son nom indique l’effectif actif au survol. Sa taille est recalculée par paliers à partir du nombre de créatures actives ; une seule créature conserve la taille d’origine.</p>

          <h5>Utilisateurs et permissions</h5>
          <p>Le MJ sélectionne dans le bandeau l’utilisateur dont il veut administrer la horde. Dans les paramètres du module, il définit le rôle minimal autorisé à accéder au menu Groupes, créer un groupe, ajouter des créatures à un groupe ou supprimer un groupe. Les permissions des actions restent limitées par la permission d’accès au menu Groupes.</p>
        </div>
      </div>
    </section>` : ""}

    <section class="nm-main-section is-active" data-main-section="combat">
    ${GROUPS.length ? `
    <div class="hm-tabs">
      ${GROUPS.map(g => `
        <div class="hm-tab-shell ${g.key === (GROUPS[0]?.key ?? "") ? "is-active" : ""}" data-tab="${g.key}">
          <button type="button" class="hm-tab" data-tab="${g.key}">
            <span class="hm-tab-label">${g.label}</span>
          </button>
          <button type="button" class="hm-tab-rename" data-tab="${g.key}" title="Renommer cet onglet" aria-label="Renommer ${g.label}">
            <i class="fas fa-pen"></i>
          </button>
        </div>
      `).join("")}
    </div>

    ${GROUPS.map(g => tabPanelHTML(g.key, g.label)).join("")}
    ` : `
      <div class="hm-card" style="text-align:center;padding:28px 16px;">
        <h3 style="margin-top:0;">Aucun groupe</h3>
        <p>Créez votre premier groupe pour commencer.</p>
      </div>
    `}
    </section>
    </div>
        `,
            buttons: {},
            render: (html) => {
                // Conserver la position et la taille entre les mises à jour de contenu.
                if (managerWindowState) dlg.setPosition(managerWindowState);
                else dlg.setPosition({ width: 760, height: 560 });

                // Restaurer l'onglet principal actif.
                const initialMainSection = canAccessSetup && activeMainSection === "setup" ? "setup" : "combat";
                html.find(".nm-main-tab").removeClass("is-active");
                html.find(`.nm-main-tab[data-main-section="${initialMainSection}"]`).addClass("is-active");
                html.find(".nm-main-section").removeClass("is-active");
                html.find(`.nm-main-section[data-main-section="${initialMainSection}"]`).addClass("is-active");

                if (initialMainSection === "setup") {
                    refreshSetupSelectors(html);
                }

                if (GROUPS.length) {
                    setActiveTab(html, (GROUPS[0]?.key ?? ""));
                    refreshAllSoon(html);
                }

                // Hooks -> refresh les 2 onglets (simple + fiable)
                cleanupHooks();
                hookUpdate = Hooks.on("updateActor", (actor) => {
                    for (const g of GROUPS) {
                        const set = lastMemberIdsByTab.get(g.key);
                        if (set?.has(actor.id)) { refreshAllSoon(html); return; }
                    }
                });
                hookCreate = Hooks.on("createActor", () => refreshAllSoon(html));
                hookDelete = Hooks.on("deleteActor", () => refreshAllSoon(html));
                hookUpdateToken = Hooks.on("updateToken", (tokenDoc) => {
                    for (const g of GROUPS) {
                        const set = lastTokenIdsByTab.get(g.key);
                        if (set?.has(tokenDoc.id)) { refreshAllSoon(html); return; }
                    }
                });

                // Rafraîchir la liste des PNJ à chaque clic sur « Créature source ».
                html.off("mousedown.nmSourceRefresh click.nmSourceRefresh")
                    .on("mousedown.nmSourceRefresh click.nmSourceRefresh", 'select[name="nmSourceActor"]', ev => {
                        const select = $(ev.currentTarget);
                        const previous = String(select.val() ?? "");

                        select.html(actorOptionsHTML());

                        if (previous && game.actors.get(previous)?.type === "npc") {
                            select.val(previous);
                        }
                    });

                const rememberWindowState = () => {
                    const pos = dlg?.position ?? {};
                    managerWindowState = {
                        left: Number.isFinite(pos.left) ? pos.left : undefined,
                        top: Number.isFinite(pos.top) ? pos.top : undefined,
                        width: Number.isFinite(pos.width) ? pos.width : 760,
                        height: Number.isFinite(pos.height) ? pos.height : 560
                    };
                };

                // ===== Sélection d'utilisateur pour le MJ =====
                html.off("change.nmUserSelector").on(
                    "change.nmUserSelector",
                    'select[name="nmUserSelector"]',
                    async ev => {
                        if (!game.user.isGM) return;
                        const userId = String(ev.currentTarget.value ?? "");
                        if (!game.users.get(userId) || userId === targetUserId) return;

                        rememberWindowState();
                        cleanupHooks();
                        dlg.close();
                        await openNecromancerManager(userId);
                    }
                );

                // ===== Navigation principale =====
                html.off("click.nmMainTabs").on("click.nmMainTabs", ".nm-main-tab", async ev => {
                    ev.preventDefault();
                    ev.stopPropagation();

                    const section = String(ev.currentTarget.dataset.mainSection ?? "combat");
                    activeMainSection = section;
                    preferredMainSection = section;

                    if (section === "setup") {
                        refreshSetupSelectors(html);
                    }

                    html.find(".nm-main-tab").removeClass("is-active");
                    html.find(`.nm-main-tab[data-main-section="${section}"]`).addClass("is-active");
                    html.find(".nm-main-section").removeClass("is-active");
                    html.find(`.nm-main-section[data-main-section="${section}"]`).addClass("is-active");
                });

                // ===== Gestion dynamique des groupes et créatures =====
                html.off("click.nmManagement").on("click.nmManagement",
                    ".btn-create-group,.btn-delete-group,.btn-add-creature,.btn-sync-group-token",
                    async ev => {
                        ev.preventDefault();
                        ev.stopPropagation();

                        if (ev.currentTarget.classList.contains("btn-create-group")) {
                            if (!canCreateGroup) return ui.notifications.warn("Permission insuffisante.");
                            new Dialog({
                                title: "Créer un groupe",
                                content: `
                                  <form class="nm-create-group-form necromancer-manager-root">
                                    <div class="form-group">
                                      <label>Nom du groupe</label>
                                      <input type="text" name="groupName" placeholder="Ex. Squelettes archers" autofocus>
                                    </div>
                                    ${game.user.isGM ? `<div class="form-group">
                                      <label>Propriétaire</label>
                                      <select name="ownerUserId" class="nm-select">${userOptionsHTML()}</select>
                                    </div>` : ""}
                                  </form>`,
                                buttons: {
                                    create: {
                                        icon: '<i class="fas fa-plus"></i>',
                                        label: "Créer",
                                        callback: async dialogHtml => {
                                            try {
                                                const name = dialogHtml.find('input[name="groupName"]').val();
                                                const ownerUserId = game.user.isGM
                                                    ? String(dialogHtml.find('select[name="ownerUserId"]').val() ?? targetUserId)
                                                    : game.user.id;
                                                const result = await createManagedGroup(name, ownerUserId);
                                                activeMainSection = "setup";
                                                preferredMainSection = "setup";
                                                rememberWindowState();
                                                cleanupHooks();
                                                dlg.close();
                                                await openNecromancerManager(result.ownerUser.id);
                                            } catch (error) {
                                                ui.notifications.error(error.message);
                                            }
                                        }
                                    },
                                    cancel: { label: "Annuler" }
                                },
                                default: "create"
                            }, {
                                classes: ["dialog", "necromancer-manager-dialog", "nm-create-group-dialog"],
                                width: 480
                            }).render(true);
                            return;
                        }

                        if (ev.currentTarget.classList.contains("btn-sync-group-token")) {
                            const groupKey = String(html.find('select[name="nmTokenGroup"]').val() ?? "");
                            const group = groupByKey(groupKey);
                            if (!group) return ui.notifications.warn("Sélectionnez un groupe.");
                            try {
                                // Le GM recalcule directement l’effectif actif à partir des PV enregistrés.
                                // Ne pas utiliser de fonction locale obsolète : cela garantit le même résultat
                                // pour un joueur comme pour un GM.
                                const result = await createOrUpdateGroupToken(group);
                                ui.notifications.info(`${result.created ? "Token créé" : "Token mis à jour"} pour « ${group.label} » — taille ${result.width} × ${result.height}.`);
                            } catch (error) {
                                console.error("Necromancer Manager | Token de groupe", error);
                                ui.notifications.error(error.message);
                            }
                            return;
                        }

                        if (ev.currentTarget.classList.contains("btn-delete-group")) {
                            if (!canDeleteGroup) return ui.notifications.warn("Permission insuffisante.");
                            const selectedKey = String(
                                html.find('select[name="nmDeleteGroup"]').val() ?? ""
                            );
                            const group = groupByKey(selectedKey);
                            if (!group) return ui.notifications.warn("Sélectionnez un groupe à supprimer.");

                            Dialog.confirm({
                                title: "Supprimer le groupe",
                                content: `<p>Supprimer le groupe <b>${escapeHTML(group.label)}</b> ?</p>
                                          <p><b>Attention :</b> le groupe, son dossier et toutes les créatures contenues dans ce dossier seront définitivement supprimés.</p>`,
                                yes: async () => {
                                    await removeManagedGroup(group, true);
                                    activeMainSection = "setup";
                                    preferredMainSection = "setup";
                                    rememberWindowState();
                                    cleanupHooks();
                                    dlg.close();
                                    await openNecromancerManager(targetUserId);
                                }
                            });
                            return;
                        }

                        if (ev.currentTarget.classList.contains("btn-add-creature")) {
                            if (!canAddCreature) return ui.notifications.warn("Permission insuffisante.");
                            const sourceId = String(html.find('select[name="nmSourceActor"]').val() ?? "");
                            const groupKey = String(html.find('select[name="nmTargetGroup"]').val() ?? "");
                            const quantity = Number(html.find('input[name="nmQuantity"]').val() ?? 1);

                            const sourceActor = game.actors.get(sourceId);
                            const group = groupByKey(groupKey);

                            if (!sourceActor) return ui.notifications.warn("Sélectionnez une créature.");
                            if (!group) return ui.notifications.warn("Sélectionnez un groupe.");

                            try {
                                const created = await duplicateCreatureIntoGroup(sourceActor, group, quantity);
                                ui.notifications.info(`${created.length} créature(s) ajoutée(s) à « ${group.label} ».`);
                                activeMainSection = "setup";
                                preferredMainSection = "setup";
                                html.find(".nm-main-tab").removeClass("is-active");
                                html.find('.nm-main-tab[data-main-section="setup"]').addClass("is-active");
                                html.find(".nm-main-section").removeClass("is-active");
                                html.find('.nm-main-section[data-main-section="setup"]').addClass("is-active");
                                refreshSetupSelectors(html);
                                refreshAllSoon(html);
                            } catch (error) {
                                console.error("Necromancer Manager | Ajout de créatures", error);
                                ui.notifications.error(error.message);
                            }
                            return;
                        }
                    }
                );

                // Renommage direct dans l'onglet, sans ouvrir de Dialog secondaire.
                html.off("click.renameGroup").on("click.renameGroup", ".hm-tab-rename", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();

                    const tabKey = String(ev.currentTarget.dataset.tab ?? "");
                    const group = GROUPS.find(g => g.key === tabKey);
                    if (!group) return;

                    const shell = html.find(`.hm-tab-shell[data-tab="${tabKey}"]`);
                    if (shell.find(".hm-tab-edit").length) return;

                    const label = shell.find(".hm-tab-label");
                    const button = shell.find(".hm-tab");
                    const currentLabel = String(group.label ?? group.key);

                    label.hide();

                    const input = $(
                        `<input type="text"
                                class="hm-tab-edit"
                                maxlength="24"
                                autocomplete="off">`
                    ).val(currentLabel);

                    button.append(input);
                    input.trigger("focus");
                    input[0]?.select();

                    let finished = false;

                    const finishRename = async save => {
                        if (finished) return;
                        finished = true;

                        const newLabel = String(input.val() ?? "").trim();
                        input.remove();
                        label.show();

                        if (!save || !newLabel || newLabel === currentLabel) return;

                        const duplicate = GROUPS.find(g =>
                            g.key !== tabKey
                            && String(g.label).trim().toLowerCase() === newLabel.toLowerCase()
                        );

                        if (duplicate) {
                            ui.notifications.warn("Ce nom est déjà utilisé par une autre catégorie.");
                            return;
                        }

                        const groupActor = getGroupActorForGroup(group);
                        if (!groupActor) {
                            ui.notifications.error(
                                `Impossible de retrouver le groupe associé à « ${currentLabel} ».`
                            );
                            return;
                        }

                        const newActorName = newLabel;
                        const actorWithSameName = game.actors.getName(newActorName);

                        if (actorWithSameName && actorWithSameName.id !== groupActor.id) {
                            ui.notifications.warn(`Un acteur nommé « ${newActorName} » existe déjà.`);
                            return;
                        }

                        try {
                            const groupFolder = game.folders.get(group.folderId)
                                ?? groupActor.folder
                                ?? null;

                            await groupActor.update({ name: newActorName });

                            if (groupFolder && groupFolder.name !== newLabel) {
                                await groupFolder.update({ name: newLabel });
                                group.folderId = groupFolder.id;
                            }

                            group.label = newLabel;
                            await persistGroups();
                            const tokenActorId = groupActor.getFlag(MODULE_ID, "groupTokenActorId");
                            if (tokenActorId) {
                                if (game.user.isGM) await gmCreateOrUpdateGroupToken(targetUser, group, await loadAllSettings());
                                else await requestGMOperation("syncGroupToken", { ownerUserId: targetUserId, groupKey: group.key });
                            }

                            label.text(newLabel);
                            shell.find(".hm-tab-rename")
                                .attr("title", `Renommer ${newLabel}`)
                                .attr("aria-label", `Renommer ${newLabel}`);

                            const panel = html.find(`.hm-tab-panel[data-tab="${tabKey}"]`);
                            panel.find(".hm-head h3").each((_, heading) => {
                                const headingElement = $(heading);
                                headingElement.text(
                                    headingElement.text().replace(/\([^()]*\)\s*$/, `(${newLabel})`)
                                );
                            });

                            ui.notifications.info(
                                `Groupe et dossier renommés en « ${newLabel} ».`
                            );
                        } catch (error) {
                            console.error("Horde | Erreur de renommage", error);
                            ui.notifications.error("Le renommage a échoué. Consultez la console.");
                        }
                    };

                    input.on("keydown", ev2 => {
                        ev2.stopPropagation();

                        if (ev2.key === "Enter") {
                            ev2.preventDefault();
                            finishRename(true);
                        } else if (ev2.key === "Escape") {
                            ev2.preventDefault();
                            finishRename(false);
                        }
                    });

                    input.on("blur", () => finishRename(true));
                });

                // Tabs click
                html.off("click.tabs").on("click.tabs", ".hm-tabs .hm-tab", (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    const tabKey = String(ev.currentTarget.dataset.tab ?? (GROUPS[0]?.key ?? ""));
                    setActiveTab(html, tabKey);
                    setActiveSection(html, tabKey, lastActiveSectionKey);
                });

                // Section tabs click
                html.off("click.section").on("click.section", ".hm-section-tab", (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    const $panel = $(ev.currentTarget).closest(".hm-tab-panel");
                    const groupKey = String($panel.data("tab") ?? (GROUPS[0]?.key ?? ""));
                    const sectionKey = String(ev.currentTarget.dataset.section ?? "active");
                    setActiveSection(html, groupKey, sectionKey);
                });

                // Boutons « tout cocher / tout décocher » pour Actifs, 0 PV et FlappyBall
                html.off("click.toggleAll").on("click.toggleAll", "button.btn-toggle-select-all", (ev) => {
                    ev.preventDefault(); ev.stopPropagation();

                    const $button = $(ev.currentTarget);
                    const $panel = $button.closest(".hm-tab-panel");
                    const checkClass = String(ev.currentTarget.dataset.checkClass ?? "").trim();
                    if (!checkClass) return;

                    const $checkboxes = $panel.find(`input.${checkClass}`);
                    const allChecked = $checkboxes.length > 0 && $checkboxes.toArray().every(cb => cb.checked);
                    $checkboxes.prop("checked", !allChecked);
                    if (checkClass === "sk-check-active") updateSelectedSkeletonList($panel);

                    const defaultLabel = String($button.data("default-label") ?? $button.text()).replace(/^Décocher /, "Cocher ");
                    $button.data("default-label", defaultLabel);
                    $button.text(!allChecked ? defaultLabel.replace(/^Cocher /, "Décocher ") : defaultLabel);
                });

                // Adv / Disadv exclusifs (scopé au panel et section)
                html.off("change.sk").on("change.sk", ".hm-tab-panel input[name='skAdv'],.hm-tab-panel input[name='skDisadv']", (ev) => {
                    const $section = $(ev.currentTarget).closest(".hm-section");
                    const adv = $section.find("input[name='skAdv']")[0].checked;
                    const disadv = $section.find("input[name='skDisadv']")[0].checked;
                    if (adv && disadv) {
                        if (ev.currentTarget.name === "skAdv") $section.find("input[name='skDisadv']").prop("checked", false);
                        else $section.find("input[name='skAdv']").prop("checked", false);
                    }
                });

                // perActor change (AA sync sur la section)
                html.off("change.pa").on("change.pa", ".hm-tab-panel input.sk-pa, .hm-tab-panel select.sk-pa", async (ev) => {
                    const $section = $(ev.currentTarget).closest(".hm-section");
                    const el = ev.currentTarget;
                    const aid = el.dataset.aid;
                    if (!aid) return;

                    if (el.classList.contains("sk-pa-feature")) lastFeatureSourceAid = aid;

                    const row = $section.find(`tr[data-aid="${aid}"]`);
                    const featureId = String(row.find("select.sk-pa-feature").val() ?? "");
                    const previous = settings?.perActor?.[aid] ?? {};
                    const next = { ...previous, featureId };
                    delete next.aa;

                    settings.perActor = settings.perActor ?? {};
                    settings.perActor[aid] = next;
                    await saveAllSettings({ perActor: { [aid]: next } });
                });


                html.off("change.selectedSkeletons").on("change.selectedSkeletons", "input.sk-check-active", (ev) => {
                    const panel = $(ev.currentTarget).closest(".hm-tab-panel");
                    updateSelectedSkeletonList(panel);
                });
                // Ouvrir la fiche en cliquant sur le nom
                html.off("click.openSheet").on("click.openSheet", "a.sk-open-sheet", async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();

                    const aid = ev.currentTarget.dataset.aid;
                    const actor = game.actors.get(aid);
                    if (!actor) return ui.notifications.warn("Acteur introuvable.");

                    actor.sheet.render(true);
                });

                // Click actions (tout est scoppé au panel + tab)
                html.off("click.hm").on("click.hm",
                    ".hm-tab-panel button.btn-send-flappy,.hm-tab-panel button.btn-return-active,.hm-tab-panel button.btn-reset-temp,.hm-tab-panel button.btn-apply,.hm-tab-panel button.btn-rez,.hm-tab-panel button.btn-sk-launch,.hm-tab-panel button.btn-copy-feature,.hm-tab-panel button.btn-active-init,.hm-tab-panel button.btn-active-attack,.hm-tab-panel button.btn-active-initiative,.hm-tab-panel button.btn-ability",
                    async (ev) => {
                        ev.preventDefault(); ev.stopPropagation();

                        const { panel, tabKey } = panelOfEvent(ev);
                        const group = groupByKey(tabKey);

                        

                        // ===== Initiative moyenne + détails =====
                        if (ev.currentTarget.classList.contains("btn-active-initiative")) {
                            const selected = panel.find("input.sk-check-active:checked").map((_, el) => el.dataset.aid).get();
                            if (!selected.length) { ui.notifications.warn("Aucun squelette actif sélectionné."); return; }

                            const data = await collectSkeletons(group);
                            if (data.error) { ui.notifications.error(data.error); return; }
                            const byAid = new Map();
                            for (const e of [...data.active, ...data.dead, ...data.fb]) byAid.set(e.actor.id, e);

                            const rolls = [];
                            for (const aid of selected) {
                                const entry = byAid.get(aid);
                                if (!entry) continue;

                                const dexMod = getDexMod(entry);
                                const actorName = entry.actor?.name ?? (game.actors.get(aid)?.name ?? aid);
                                const r = await new Roll("1d20 + @dex", { dex: dexMod }).evaluate({ async: true });
                                rolls.push({ name: actorName, dexMod, total: r.total });
                            }
                            if (!rolls.length) { ui.notifications.warn("Aucun token/acteur valide pour l'initiative."); return; }

                            const sum = rolls.reduce((a, b) => a + (Number(b.total) || 0), 0);
                            const avg = sum / rolls.length;
                            const avgStr = (Math.round(avg * 100) / 100).toString();

                            let content = `<h3>⚡ Initiative (Actifs sélectionnés)</h3>`;
                            content += `<p><b>Moyenne des initiatives :</b> ${avgStr}</p>`;
                            content += `<details><summary><b>Voir les jets</b></summary><ul style="margin-top:8px;">`;
                            for (const r of rolls) {
                                const sign = r.dexMod >= 0 ? "+" : "";
                                content += `<li><b>${r.name}</b> — (1d20 ${sign}${r.dexMod}) = <b>${r.total}</b></li>`;
                            }
                            content += `</ul></details>`;
                            let initiativeUpdated = false;
                            try {
                                const result = await requestGMOperation("setGroupInitiative", {
                                    ownerUserId: targetUserId,
                                    groupKey: group.key,
                                    initiative: avg
                                });
                                initiativeUpdated = !!result?.updated;
                            } catch (error) {
                                console.warn("Necromancer Manager | Mise à jour automatique de l'initiative", error);
                            }

                            content += initiativeUpdated
                                ? `<p><b>Combat :</b> l’initiative du token de groupe a été mise à jour automatiquement.</p>`
                                : `<p><b>Information :</b> Le groupe ${escapeHTML(group.label)} n'est pas dans un combat.</p>`;
                            ChatMessage.create({ content });
                            return;
                        }

                        // ===== Copier l'action choisie vers tous les actifs sélectionnés =====
                        if (ev.currentTarget.classList.contains("btn-copy-feature")) {
                            const selected = panel.find("input.sk-check-active:checked").map((_, el) => el.dataset.aid).get();
                            if (selected.length < 2) {
                                ui.notifications.warn("Sélectionnez au moins deux actifs.");
                                return;
                            }

                            // Priorité au dernier menu Action modifié parmi les acteurs cochés.
                            // À défaut, le premier acteur coché devient la source.
                            const sourceAid = selected.includes(lastFeatureSourceAid)
                                ? lastFeatureSourceAid
                                : selected[0];

                            const sourceActor = game.actors.get(sourceAid);
                            const sourceRow = panel.find(`tr[data-aid="${sourceAid}"]`);
                            const sourceFeatureId = String(sourceRow.find("select.sk-pa-feature").val() ?? "");
                            const sourceFeature = resolveFeatureSelection(sourceActor, sourceFeatureId);

                            if (!sourceActor || !sourceFeature) {
                                ui.notifications.warn("L'activité source est introuvable.");
                                return;
                            }

                            const sourceItem = sourceFeature.item;
                            const sourceNameKey = sourceFeature.matchKey;
                            const settingsPatch = {};
                            const missing = [];
                            let copied = 0;

                            for (const aid of selected) {
                                if (aid === sourceAid) continue;

                                const actor = game.actors.get(aid);
                                const row = panel.find(`tr[data-aid="${aid}"]`);
                                if (!actor || !row.length) {
                                    missing.push(actor?.name ?? aid);
                                    continue;
                                }

                                // Les IDs d'objets diffèrent d'un acteur à l'autre :
                                // on recherche donc la feature équivalente par son nom.
                                const targetFeature = getActorFeatures(actor).find(feature =>
                                    feature.matchKey === sourceNameKey
                                );

                                if (!targetFeature) {
                                    missing.push(actor.name);
                                    continue;
                                }

                                row.find("select.sk-pa-feature").val(targetFeature.id);

                                const previous = settings?.perActor?.[aid] ?? {};
                                const next = {
                                    ...previous,
                                    featureId: targetFeature.id
                                };
                                delete next.aa;

                                settings.perActor = settings.perActor ?? {};
                                settings.perActor[aid] = next;
                                settingsPatch[aid] = next;
                                copied++;
                            }

                            if (Object.keys(settingsPatch).length) {
                                await saveAllSettings({ perActor: settingsPatch });
                            }

                            const sourceLabel = sourceFeature.name;
                            if (missing.length) {
                                ui.notifications.warn(
                                    `« ${sourceLabel} » appliquée à ${copied} actif(s). Feature absente : ${missing.join(", ")}.`
                                );
                            } else {
                                ui.notifications.info(`« ${sourceLabel} » appliquée à ${copied} autre(s) actif(s).`);
                            }
                            return;
                        }

                        // ===== Init (sélection de feature pour les actifs) =====
                        if (ev.currentTarget.classList.contains("btn-active-init")) {
                            const selected = panel.find("input.sk-check-active:checked").map((_, el) => el.dataset.aid).get();
                            if (!selected.length) { ui.notifications.warn("Aucun squelette actif sélectionné."); return; }

                            ui.notifications.info("Les actions sont maintenant sélectionnées dans la colonne 'Action' pour chaque squelette.");
                            return;
                        }

                        function damageTypeKey(type) {
                            const value = String(type ?? "").trim().toLowerCase();
                            return value || "autre";
                        }

                        function damageTypeLabel(type) {
                            const labels = {
                                acid: "Acide", bludgeoning: "Cont.", cold: "Froid",
                                fire: "Feu", force: "Force", lightning: "Foudre",
                                necrotic: "Nécro.", piercing: "Perf.", poison: "Poison",
                                psychic: "Psy.", radiant: "Rad.", slashing: "Tranch.",
                                thunder: "Ton.", healing: "Soin", autre: "Autre"
                            };
                            const key = damageTypeKey(type);
                            return labels[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
                        }

                        function sumDamageByType(details, multiplier = 1) {
                            const totals = {};
                            for (const detail of details ?? []) {
                                const key = damageTypeKey(detail.type);
                                const value = Number(detail.total ?? 0) || 0;
                                totals[key] = (totals[key] ?? 0) + Math.floor(value * multiplier);
                            }
                            return totals;
                        }

                        function mergeDamageByType(target, source) {
                            for (const [type, value] of Object.entries(source ?? {})) {
                                target[type] = (target[type] ?? 0) + (Number(value) || 0);
                            }
                            return target;
                        }

                        function compactDamageTableStyle() {
                            return "width:auto;max-width:100%;margin:0 auto;text-align:center;border-collapse:collapse;font-size:12px;line-height:1.1;";
                        }

                        function compactCellStyle(isHeader = false) {
                            return `padding:${isHeader ? "4px 5px" : "3px 5px"};white-space:nowrap;${isHeader ? "font-weight:700;" : ""}`;
                        }

                        // ===== Attaque automatisée depuis l'activité "Midi Attack" =====
                        if (ev.currentTarget.classList.contains("btn-active-attack")) {
                            const selected = panel.find("input.sk-check-active:checked").map((_, el) => el.dataset.aid).get();
                            if (!selected.length) { ui.notifications.warn("Aucun squelette actif sélectionné."); return; }

                            const featuresByActor = {};
                            for (const aid of selected) {
                                const actor = game.actors.get(aid);
                                if (!actor) continue;

                                const row = panel.find(`tr[data-aid="${aid}"]`);
                                const featureId = String(row.find("select.sk-pa-feature").val() ?? "");
                                const selection = resolveFeatureSelection(actor, featureId);
                                if (!selection) continue;

                                const { item, activity } = selection;
                                const featureInfo = await analyzeFeature(item, activity);
                                if (!featureInfo) continue;
                                featuresByActor[aid] = { actor, item, activity, selection, featureInfo, row };
                            }

                            const validEntries = selected.map(aid => featuresByActor[aid]).filter(Boolean);
                            if (!validEntries.length) {
                                ui.notifications.warn("Aucune activité exploitable trouvée sur les actions sélectionnées.");
                                return;
                            }

                            const saveEntries = validEntries.filter(e => e.featureInfo.type === "save");
                            const attackEntries = validEntries.filter(e => e.featureInfo.type === "attack");
                            const damageEntries = validEntries.filter(e => e.featureInfo.type === "damage");
                            const usedTypes = [
                                saveEntries.length ? "save" : null,
                                attackEntries.length ? "attack" : null,
                                damageEntries.length ? "damage" : null
                            ].filter(Boolean);

                            if (usedTypes.length > 1) {
                                ui.notifications.warn(
                                    "La sélection mélange des attaques, des sauvegardes ou des dégâts directs. Sélectionnez un seul type à la fois."
                                );
                                return;
                            }

                            if (saveEntries.length) {
                                const first = saveEntries[0].featureInfo;
                                const dc = first.dc;
                                const ability = first.ability;
                                const saveMode = first.saveDamageMode;
                                let failedTotal = 0;
                                let successTotal = 0;
                                const results = [];

                                for (const { actor, item, featureInfo } of saveEntries) {
                                    const damage = await rollDamageParts(featureInfo, false);
                                    const successDamage = saveMode === "none"
                                        ? 0
                                        : saveMode === "full"
                                            ? damage.total
                                            : Math.floor(damage.total / 2);

                                    failedTotal += damage.total;
                                    successTotal += successDamage;
                                    results.push({
                                        name: actor.name,
                                        itemName: item.name,
                                        total: damage.total,
                                        successDamage,
                                        details: damage.details
                                    });
                                }

                                const successLabel = saveMode === "none"
                                    ? "Aucun dégât"
                                    : saveMode === "full"
                                        ? "Dégâts complets"
                                        : "Demi-dégâts";

                                const saveFeatureNames = [...new Set(saveEntries.map(entry => entry.item?.name).filter(Boolean))];
                                const saveTitle = saveFeatureNames.length
                                    ? saveFeatureNames.join(" + ")
                                    : "Jet de sauvegarde";
                                let content = `<h3>💀 ${saveTitle}</h3>`;
                                content += `<p><b>DD ${dc}</b> — <b>${ability.toUpperCase()}</b><br><b>En cas de réussite :</b> ${successLabel}</p>`;
                                content += `<details><summary><b>Voir les jets de dégâts</b></summary><ul style="margin-top:8px;">`;
                                for (const r of results) {
                                    const detail = r.details.map(d => `${d.rolledFormula}${d.type ? ` [${d.type}]` : ""} = <b>${d.total}</b>`).join(" + ");
                                    content += `<li><b>${r.name}</b> — ${r.itemName}<br>${detail}<br>Total : <b>${r.total}</b></li>`;
                                }
                                content += `</ul></details><br>`;

                                const damageTypes = [...new Set(results.flatMap(r => r.details.map(d => damageTypeKey(d.type))))];
                                const failedByType = {};
                                const successByType = {};
                                const successMultiplier = saveMode === "none" ? 0 : saveMode === "full" ? 1 : 0.5;
                                for (const r of results) {
                                    mergeDamageByType(failedByType, sumDamageByType(r.details, 1));
                                    mergeDamageByType(successByType, sumDamageByType(r.details, successMultiplier));
                                }

                                const th = compactCellStyle(true);
                                const td = compactCellStyle(false);
                                content += `<div style="overflow-x:auto;"><table border="1" style="${compactDamageTableStyle()}"><thead><tr>`;
                                content += `<th style="${th}">Jet</th>`;
                                for (const type of damageTypes) content += `<th style="${th}" title="${type}">${damageTypeLabel(type)}</th>`;
                                content += `<th style="${th}">Total</th></tr></thead><tbody>`;
                                content += `<tr><td style="${td}"><b>Échec</b></td>`;
                                for (const type of damageTypes) content += `<td style="${td}">${failedByType[type] ?? 0}</td>`;
                                content += `<td style="${td}"><b>${failedTotal}</b></td></tr>`;
                                content += `<tr><td style="${td}"><b>Réussite</b></td>`;
                                for (const type of damageTypes) content += `<td style="${td}">${successByType[type] ?? 0}</td>`;
                                content += `<td style="${td}"><b>${successTotal}</b></td></tr>`;
                                content += `</tbody></table></div>`;
                                await ChatMessage.create({ content });
                                return;
                            }

                            const acMin = Number(panel.find("input[name='skAcMin']").val()) || 12;
                            const acMax = Number(panel.find("input[name='skAcMax']").val()) || 20;
                            if (damageEntries.length) {
                                let grandTotal = 0;
                                const results = [];

                                for (const { actor, item, featureInfo } of damageEntries) {
                                    const damage = await rollDamageParts(featureInfo, false);
                                    grandTotal += damage.total;
                                    results.push({
                                        name: actor.name,
                                        itemName: item.name,
                                        activityName: featureInfo.activityName,
                                        total: damage.total,
                                        details: damage.details
                                    });
                                }

                                const activityNames = [...new Set(
                                    damageEntries
                                        .map(entry => `${entry.item?.name} — ${entry.featureInfo.activityName}`)
                                        .filter(Boolean)
                                )];

                                let content = `<h3>💥 ${activityNames.join(" + ") || "Dégâts directs"}</h3>`;
                                content += `<p><b>Dégâts cumulés :</b> ${grandTotal}</p>`;
                                content += `<details><summary><b>Voir le détail</b></summary><ul style="margin-top:8px;">`;

                                for (const result of results) {
                                    const detailText = result.details
                                        .map(detail => `${detail.rolledFormula} = ${detail.total}`)
                                        .join(" + ");
                                    content += `<li><b>${result.name}</b> — ${result.itemName} — ${result.activityName}: <b>${result.total}</b>${detailText ? ` (${detailText})` : ""}</li>`;
                                }

                                content += `</ul></details>`;
                                await ChatMessage.create({ content });
                                return;
                            }

                            const mode = String(panel.find("input[name^='activeAttackMode-']:checked").val() ?? "normal");
                            const globalAttackModifier = Number(panel.find("input[name='activeAttackBonus']").val()) || 0;
                            const attackFormula = mode === "adv" ? "2d20kh" : mode === "disadv" ? "2d20kl" : "1d20";
                            const modeLabel = mode === "adv" ? "Avantage" : mode === "disadv" ? "Désavantage" : "Normal";
                            const rolls = [];
                            let critSuccess = 0;
                            let critFail = 0;

                            for (const { actor, item, featureInfo, row } of attackEntries) {
                                const bonus = Number(featureInfo.bonus ?? 0) + globalAttackModifier;
                                const d20Roll = await new Roll(attackFormula).evaluate({ async: true });
                                const d20Results = getD20Results(d20Roll);
                                const natural = mode === "adv"
                                    ? Math.max(...d20Results)
                                    : mode === "disadv"
                                        ? Math.min(...d20Results)
                                        : d20Results[0] ?? d20Roll.total;
                                const attackTotal = Number(d20Roll.total) + bonus;

                                let outcome = "normal";
                                let damage = { total: 0, details: [] };
                                if (natural === 1) {
                                    outcome = "critFail";
                                    critFail++;
                                } else {
                                    const critical = natural === 20;
                                    if (critical) {
                                        outcome = "crit";
                                        critSuccess++;
                                    }
                                    damage = await rollDamageParts(featureInfo, critical);
                                }

                                rolls.push({
                                    name: actor.name,
                                    itemName: item.name,
                                    natural,
                                    d20Results,
                                    bonus,
                                    attackTotal,
                                    outcome,
                                    damageTotal: damage.total,
                                    damageDetails: damage.details
                                });
                            }

                            const attackFeatureNames = [...new Set(attackEntries.map(entry => entry.item?.name).filter(Boolean))];
                            const attackTitle = attackFeatureNames.length
                                ? attackFeatureNames.join(" + ")
                                : "Attaque";
                            let content = `<h3>💀 ${attackTitle}</h3>`;
                            const modifierLabel = globalAttackModifier >= 0 ? `+${globalAttackModifier}` : `${globalAttackModifier}`;
                            content += `<p><b>Nombre :</b> ${rolls.length}<br><b>Mode :</b> ${modeLabel}<br><b>Bonus / malus global :</b> ${modifierLabel}</p>`;
                            content += `<details><summary><b>Voir les jets exacts</b></summary><ul style="margin-top:8px;">`;
                            for (const r of rolls) {
                                const tag = r.outcome === "crit" ? " — <b>Critique</b>" : r.outcome === "critFail" ? " — <b>Échec critique</b>" : "";
                                const diceText = r.d20Results.join(", ");
                                const damageText = r.damageDetails.length
                                    ? r.damageDetails.map(d => `${d.rolledFormula}${d.type ? ` [${d.type}]` : ""} = ${d.total}`).join(" + ") + ` → <b>${r.damageTotal}</b>`
                                    : "-";
                                content += `<li><b>${r.name}</b> — ${r.itemName}<br>d20 [${diceText}] + ${r.bonus} = <b>${r.attackTotal}</b>${tag}<br>Dégâts : ${damageText}</li>`;
                            }
                            content += `</ul></details><br>`;

                            const damageTypes = [...new Set(rolls.flatMap(r => r.damageDetails.map(d => damageTypeKey(d.type))))];
                            const th = compactCellStyle(true);
                            const td = compactCellStyle(false);

                            // Une cible Foundry sélectionnée remplace automatiquement le tableau par plage de CA.
                            // Sans cible valide, le comportement historique CA min -> CA max est conservé.
                            const targetedTokens = Array.from(game.user?.targets ?? []);
                            const validTargets = targetedTokens.map(token => {
                                const acRaw = token?.actor?.system?.attributes?.ac?.value
                                    ?? token?.actor?.system?.attributes?.ac?.flat
                                    ?? token?.document?.actor?.system?.attributes?.ac?.value;
                                const ac = Number(acRaw);
                                return {
                                    token,
                                    name: String(token?.name ?? token?.actor?.name ?? "Cible"),
                                    ac
                                };
                            }).filter(target => Number.isFinite(target.ac));

                            if (targetedTokens.length && validTargets.length !== targetedTokens.length) {
                                const ignored = targetedTokens.length - validTargets.length;
                                ui.notifications.warn(`${ignored} cible(s) ignorée(s) : CA introuvable.`);
                            }

                            if (validTargets.length) {
                                // Tableau générique placé visuellement juste sous « Voir les jets exacts ».
                                // La CA réelle de la cible reste cachée.
                                content += `<details style="margin-top:2px;"><summary><b>Voir le tableau complet par CA</b></summary>`;
                                content += `<div style="overflow-x:auto;margin-top:6px;"><table border="1" style="${compactDamageTableStyle()}"><thead><tr>`;
                                content += `<th style="${th}">CA</th><th style="${th}">Touchés</th>`;
                                for (const type of damageTypes) content += `<th style="${th}" title="${type}">${damageTypeLabel(type)}</th>`;
                                content += `<th style="${th}">Total</th></tr></thead><tbody>`;

                                const realAcMin = Math.min(acMin, acMax);
                                const realAcMax = Math.max(acMin, acMax);
                                for (let ac = realAcMin; ac <= realAcMax; ac++) {
                                    let hits = 0;
                                    let totalDamage = 0;
                                    const totalsByType = {};

                                    for (const r of rolls) {
                                        const hit = r.natural === 20 || (r.natural !== 1 && r.attackTotal >= ac);
                                        if (!hit) continue;

                                        hits++;
                                        totalDamage += r.damageTotal;
                                        mergeDamageByType(totalsByType, sumDamageByType(r.damageDetails));
                                    }

                                    content += `<tr><td style="${td}">${ac}</td><td style="${td}">${hits}/${rolls.length}</td>`;
                                    for (const type of damageTypes) content += `<td style="${td}">${totalsByType[type] ?? 0}</td>`;
                                    content += `<td style="${td}"><b>${totalDamage}</b></td></tr>`;
                                }

                                content += `</tbody></table></div></details>`;

                                content += `<p style="margin:12px 0 6px 0;"><b>Cible${validTargets.length > 1 ? "s" : ""} :</b> ${validTargets.map(t => t.name).join(", ")}</p>`;
                                content += `<div style="overflow-x:auto;"><table border="1" style="${compactDamageTableStyle()}"><thead><tr>`;
                                content += `<th style="${th}">Cible</th><th style="${th}">Touchés</th>`;
                                for (const type of damageTypes) content += `<th style="${th}" title="${type}">${damageTypeLabel(type)}</th>`;
                                content += `<th style="${th}">Total</th></tr></thead><tbody>`;

                                for (const target of validTargets) {
                                    let hits = 0;
                                    let totalDamage = 0;
                                    const totalsByType = {};

                                    for (const r of rolls) {
                                        const hit = r.natural === 20 || (r.natural !== 1 && r.attackTotal >= target.ac);
                                        if (!hit) continue;

                                        hits++;
                                        totalDamage += r.damageTotal;
                                        mergeDamageByType(totalsByType, sumDamageByType(r.damageDetails));
                                    }

                                    content += `<tr>`;
                                    content += `<td style="${td};text-align:left;"><b>${target.name}</b></td>`;
                                    content += `<td style="${td}">${hits}/${rolls.length}</td>`;
                                    for (const type of damageTypes) content += `<td style="${td}">${totalsByType[type] ?? 0}</td>`;
                                    content += `<td style="${td}"><b>${totalDamage}</b></td>`;
                                    content += `</tr>`;
                                }

                                content += `</tbody></table></div>`;
                            } else {
                                content += `<div style="overflow-x:auto;"><table border="1" style="${compactDamageTableStyle()}"><thead><tr>`;
                                content += `<th style="${th}">CA</th><th style="${th}">Touchés</th>`;
                                for (const type of damageTypes) content += `<th style="${th}" title="${type}">${damageTypeLabel(type)}</th>`;
                                content += `<th style="${th}">Total</th></tr></thead><tbody>`;

                                const realAcMin = Math.min(acMin, acMax);
                                const realAcMax = Math.max(acMin, acMax);
                                for (let ac = realAcMin; ac <= realAcMax; ac++) {
                                    let hits = 0;
                                    let totalDamage = 0;
                                    const totalsByType = {};

                                    for (const r of rolls) {
                                        const hit = r.natural === 20 || (r.natural !== 1 && r.attackTotal >= ac);
                                        if (!hit) continue;

                                        hits++;
                                        totalDamage += r.damageTotal;
                                        mergeDamageByType(totalsByType, sumDamageByType(r.damageDetails));
                                    }

                                    content += `<tr><td style="${td}">${ac}</td><td style="${td}">${hits}/${rolls.length}</td>`;
                                    for (const type of damageTypes) content += `<td style="${td}">${totalsByType[type] ?? 0}</td>`;
                                    content += `<td style="${td}"><b>${totalDamage}</b></td></tr>`;
                                }

                                content += `</tbody></table></div>`;
                            }

                            content += `<div style="margin-top:5px;font-size:11px;"><b>Crit.</b> ${critSuccess} · <b>Échecs crit.</b> ${critFail}</div>`;
                            await ChatMessage.create({ content });
                            return;
                        }

                        // ===== Reset PV temp =====
                        if (ev.currentTarget.classList.contains("btn-reset-temp")) {
                            const data = await collectSkeletons(group);
                            if (data.error) return ui.notifications.error(data.error);

                            let count = 0;
                            for (const entry of [...data.active, ...data.dead, ...data.fb]) {
                                const src = hpSource(entry);
                                const curTemp = getHPTempFrom(src) ?? 0;
                                if (curTemp === 0) continue;

                                await applyHPUpdate(entry, getHPValueFrom(src) ?? 0, 0);
                                count++;
                            }

                            if (!count) { ui.notifications.info("Aucun PV temp à reset."); clearUI(panel); refreshAllSoon(html); return; }
                            ui.notifications.info(`PV temp remis à 0 pour ${count} membre(s).`);
                            ChatMessage.create({ content: `<p><b>Reset PV temp</b> : ${count} membre(s) ont maintenant <b>0 PV temp</b>.</p>` });
                            clearUI(panel); refreshAllSoon(html);
                            return;
                        }

                        // ===== Apply HP ops =====
                        if (ev.currentTarget.classList.contains("btn-apply")) {
                            const addHP = Number(panel.find("input[name='addHP']").val() ?? 0) || 0;
                            const tempDelta = Number(panel.find("input[name='setTempMin']").val() ?? 0) || 0;

                            const selected = panel.find("input.sk-check-active:checked").map((_, el) => el.dataset.aid).get();
                            if (!selected.length) { ui.notifications.warn("Aucun squelette actif sélectionné."); return; }

                            const data = await collectSkeletons(group);
                            const byAid = new Map();
                            for (const e of [...data.active, ...data.dead, ...data.fb]) byAid.set(e.actor.id, e);

                            const reducedToZero = [];
                            let updated = 0;

                            for (const aid of selected) {
                                const entry = byAid.get(aid);
                                if (!entry) continue;

                                const src = hpSource(entry);
                                let hp = getHPValueFrom(src);
                                let temp = getHPTempFrom(src);
                                const max = hpMax(entry);

                                if (hp == null || Number.isNaN(hp)) continue;
                                if (temp == null || Number.isNaN(temp)) temp = 0;

                                const beforeHP = hp;

                                if (!Number.isNaN(addHP) && addHP !== 0) hp = hp + addHP;
                                if (Number.isFinite(tempDelta) && tempDelta !== 0) temp += tempDelta;

                                hp = Math.max(0, Math.min(hp, max));
                                temp = Math.max(0, temp);

                                if (beforeHP > 0 && hp === 0) reducedToZero.push(entry.actor.name);

                                await applyHPUpdate(entry, hp, temp);
                                updated++;
                            }

                            if (!updated) { ui.notifications.warn("Aucune mise à jour à appliquer."); return; }
                            // Une modification sans mort ne change pas l'effectif actif.
                            // En cas de passage à 0 PV, appelle la même méthode que le
                            // bouton « Créer / mettre à jour le token ».
                            if (reducedToZero.length) await syncExistingGroupTokenFromCurrentList(group);
                            ui.notifications.info(`Mise à jour effectuée sur ${updated} squelette(s).`);

                            if (reducedToZero.length) {
                                const list = reducedToZero.map(n => `<li><b>${n}</b></li>`).join("");
                                ChatMessage.create({ content: `<h3>💀 Squelettes réduits à 0 PV</h3><ul>${list}</ul>` });
                            }

                            clearUI(panel); refreshAllSoon(html);
                            return;
                        }

                        // ===== Rez =====
                        if (ev.currentTarget.classList.contains("btn-rez")) {
                            const selected = panel.find("input.sk-check-dead:checked").map((_, el) => el.dataset.aid).get();
                            if (!selected.length) { ui.notifications.warn("Aucun squelette à 0 PV sélectionné."); return; }

                            const data = await collectSkeletons(group);
                            const byAid = new Map();
                            for (const e of [...data.active, ...data.dead, ...data.fb]) byAid.set(e.actor.id, e);

                            let count = 0;
                            for (const aid of selected) {
                                const entry = byAid.get(aid);
                                if (!entry) continue;
                                const max = hpMax(entry);
                                await setHPValueOnly(entry, max);
                                count++;
                            }

                            if (!count) return;
                            // La résurrection modifie l'effectif actif : réutilise la
                            // méthode du bouton pour mettre à jour Actor et tokens placés.
                            await syncExistingGroupTokenFromCurrentList(group);
                            ui.notifications.info(`Réanimer : ${count} squelette(s) remis à leurs PV max.`);
                            ChatMessage.create({ content: `<p><b>Réanimer</b> : ${count} squelette(s) remis à <b>leurs PV max</b>.</p>` });

                            clearUI(panel); refreshAllSoon(html);
                            return;
                        }

                        // ===== Déplacement vers / depuis FlappyBall =====
                        if (ev.currentTarget.classList.contains("btn-send-flappy") || ev.currentTarget.classList.contains("btn-return-active")) {
                            const toFlappy = ev.currentTarget.classList.contains("btn-send-flappy");
                            const selector = toFlappy ? "input.sk-check-active:checked" : "input.sk-check-fb:checked";
                            const selected = panel.find(selector).map((_, el) => el.dataset.aid).get();
                            if (!selected.length) {
                                ui.notifications.warn(toFlappy ? "Aucun squelette actif sélectionné." : "Aucun squelette FlappyBall sélectionné.");
                                return;
                            }

                            const updates = [];
                            for (const aid of selected) {
                                const a = game.actors.get(aid);
                                if (!a) continue;
                                const oldName = String(a.name ?? "");
                                const newName = toFlappy
                                    ? (hasFBPrefix(oldName) ? oldName : `${FB_PREFIX} ${oldName}`)
                                    : stripFBPrefix(oldName);
                                if (newName !== oldName) updates.push({ _id: a.id, name: newName });
                            }

                            if (!updates.length) { ui.notifications.info("Aucune modification à effectuer."); clearUI(panel); refreshAllSoon(html); return; }
                            await Actor.updateDocuments(updates);
                            await syncExistingGroupTokenFromCurrentList(group);
                            ui.notifications.info(toFlappy
                                ? `${updates.length} squelette(s) envoyé(s) dans FlappyBall.`
                                : `${updates.length} squelette(s) renvoyé(s) vers Squelettes actifs.`);
                            clearUI(panel); refreshAllSoon(html);
                            return;
                        }

                        // ===== TESTS DE CARACTÉRISTIQUE / SAVE (sans DiceSoNice) =====
                        if (ev.currentTarget.classList.contains("btn-ability")) {
                            const ability = ev.currentTarget.dataset.ability;

                            const selected = panel.find("input.sk-check-active:checked").map((_, el) => el.dataset.aid).get();
                            if (!selected.length) { ui.notifications.warn("Aucun squelette actif sélectionné."); return; }

                            let promptDlg = null;

                            promptDlg = new Dialog({
                                title: `Test (${ability.toUpperCase()})`,
                                content: `
    <style>
      .hm-testdlg .window-content{ background: rgba(24,26,32,.92) !important; }
      .hm-testdlg .window-content, .hm-testdlg .window-content *{ color: rgba(255,255,255,.92) !important; }
      .hm-testdlg .window-content form{ margin-bottom: 18px; }

      .hm-test-wrap{ display:flex; flex-direction:column; gap:12px; }
      .hm-row{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }

      .hm-box{
        border:1px solid rgba(255,255,255,.14);
        background: rgba(38,40,48,.78);
        border-radius:12px;
        padding:10px;
        box-shadow: 0 6px 18px rgba(0,0,0,.25);
      }
      .hm-choice{ display:flex; align-items:center; gap:10px; font-weight:900; }
      .hm-choice input{ margin:0; transform: translateY(1px); }

      .hm-ddbox{ display:flex; justify-content:center; align-items:center; gap:8px; }
      .hm-ddbox label{ font-weight:900; margin:0; }
      .hm-ddbox input[type="number"]{
        width:110px; height:30px; text-align:center;
        background: rgba(255,255,255,.10) !important;
        border: 1px solid rgba(255,255,255,.18) !important;
        border-radius: 8px !important;
      }

      .hm-testdlg button{
        border:1px solid rgba(255,255,255,.16) !important;
        background: rgba(255,255,255,.08) !important;
        border-radius:10px;
        font-weight:900;
      }
    </style>

    <form class="hm-test-wrap">
      <div class="hm-row">
        <div class="hm-box"><label class="hm-choice"><input type="radio" name="mode" value="test" checked> Test de caractéristique</label></div>
        <div class="hm-box"><label class="hm-choice"><input type="radio" name="mode" value="save"> Test de sauvegarde</label></div>
      </div>

      <div class="hm-row">
        <div class="hm-box"><label class="hm-choice"><input type="checkbox" name="adv"> Avantage</label></div>
        <div class="hm-box"><label class="hm-choice"><input type="checkbox" name="disadv"> Désavantage</label></div>
      </div>

      <div class="hm-box">
        <div class="hm-ddbox">
          <label>DD (optionnel)</label>
          <input type="number" name="dc" min="1" placeholder="—">
        </div>
      </div>
    </form>
                  `,
                                buttons: {
                                    ok: {
                                        label: "Lancer",
                                        callback: async (dlgHtml) => {
                                            try { promptDlg?.close(); } catch (e) {}

                                            const adv = !!dlgHtml.find("input[name='adv']")[0]?.checked;
                                            const disadv = !!dlgHtml.find("input[name='disadv']")[0]?.checked;

                                            const mode = dlgHtml.find("input[name='mode']:checked").val();
                                            const dcRaw = dlgHtml.find("input[name='dc']").val();
                                            const dc = (dcRaw !== "" && dcRaw != null) ? Number(dcRaw) : null;

                                            const results = [];

                                            for (const aid of selected) {
                                                const actor = game.actors.get(aid);
                                                if (!actor) continue;

                                                const abl = actor.system?.abilities?.[ability];
                                                const mod = (mode === "save")
                                                    ? Number(abl?.save ?? 0)
                                                    : Number(abl?.mod ?? 0);

                                                const d20Formula = (adv && !disadv)
                                                    ? "2d20kh"
                                                    : (disadv && !adv)
                                                        ? "2d20kl"
                                                        : "1d20";

                                                const roll = await new Roll(`${d20Formula} + @mod`, { mod }).evaluate({ async: true });
                                                const total = Number(roll.total ?? 0);
                                                const dice = getD20Results(roll);

                                                const picked = (adv && !disadv)
                                                    ? (dice.length ? Math.max(...dice) : null)
                                                    : (disadv && !adv)
                                                        ? (dice.length ? Math.min(...dice) : null)
                                                        : (dice[0] ?? null);

                                                results.push({
                                                    name: actor.name,
                                                    total,
                                                    mod,
                                                    dice,
                                                    picked,
                                                    success: dc != null ? total >= dc : null
                                                });
                                            }

                                            if (!results.length) return;

                                            const title = mode === "save" ? "Sauvegarde" : "Test";
                                            const modeLabel = adv && !disadv
                                                ? "Avantage"
                                                : disadv && !adv
                                                    ? "Désavantage"
                                                    : "Normal";

                                            const th = compactCellStyle(true);
                                            const td = compactCellStyle(false);
                                            const signNumber = value => `${Number(value) >= 0 ? "+" : ""}${Number(value) || 0}`;

                                            let content = `<h3>🧪 ${title} ${ability.toUpperCase()}</h3>`;
                                            content += `<p style="margin:0 0 6px 0;"><b>${results.length}</b> jet(s) — ${modeLabel}`;
                                            if (dc != null) content += ` — <b>DD ${dc}</b>`;
                                            content += `</p>`;

                                            // Tableau détaillé compact, avec ou sans DD.
                                            content += `<div style="overflow-x:auto;"><table border="1" style="${compactDamageTableStyle()}"><thead><tr>`;
                                            content += `<th style="${th}">Nom</th>`;
                                            content += `<th style="${th}">d20</th>`;
                                            content += `<th style="${th}">Bonus</th>`;
                                            content += `<th style="${th}">Total</th>`;
                                            if (dc != null) content += `<th style="${th}"></th>`;
                                            content += `</tr></thead><tbody>`;

                                            for (const r of results) {
                                                const diceText = r.dice.length
                                                    ? r.dice.join(" / ")
                                                    : String(r.picked ?? "?");

                                                content += `<tr>`;
                                                content += `<td style="${td};text-align:left;"><b>${r.name}</b></td>`;
                                                content += `<td style="${td}">${diceText}</td>`;
                                                content += `<td style="${td}">${signNumber(r.mod)}</td>`;
                                                content += `<td style="${td}"><b>${r.total}</b></td>`;
                                                if (dc != null) {
                                                    content += `<td style="${td};font-size:14px;">${r.success ? "✅" : "❌"}</td>`;
                                                }
                                                content += `</tr>`;
                                            }
                                            content += `</tbody></table></div>`;

                                            if (dc != null) {
                                                const successes = results.filter(r => r.success).length;
                                                const failures = results.length - successes;

                                                content += `<div style="display:flex;justify-content:center;gap:14px;margin-top:6px;font-size:12px;">`;
                                                content += `<span>✅ <b>${successes}/${results.length}</b></span>`;
                                                content += `<span>❌ <b>${failures}/${results.length}</b></span>`;
                                                content += `</div>`;
                                            }

                                            await ChatMessage.create({ content });
                                        }
                                    }
                                },
                                default: "ok"
                            }, {
                                classes: ["hm-testdlg"],
                                resizable: true
                            });

                            promptDlg.render(true);
                            setTimeout(() => promptDlg.setPosition({ width: 450, height: 285 }), 30);
                            return;
                        }

                        // ===== Lancer (simulation attacks) =====
                        if (ev.currentTarget.classList.contains("btn-sk-launch")) {
                            const attacks = Number(panel.find("input[name='skAttacks']").val()) || 1;
                            const baseBonus = Number(panel.find("input[name='skAtkBonus']").val()) || 0;
                            let plusOnes = 0;
                            const dmgBase = String(panel.find("input[name='skDmg']").val() ?? "1d6+3").trim() || "1d6+3";
                            const acMin = Number(panel.find("input[name='skAcMin']").val()) || 12;
                            const acMax = Number(panel.find("input[name='skAcMax']").val()) || 20;

                            await saveAllSettings({ atkBonus: baseBonus, plusOnes: plusOnes, acMin: acMin, acMax: acMax, dmg: dmgBase });

                            const adv = panel.find("input[name='skAdv']")[0]?.checked ?? false;
                            const disadv = panel.find("input[name='skDisadv']")[0]?.checked ?? false;
                            const mode = (adv && !disadv) ? "adv" : (disadv && !adv) ? "disadv" : "normal";

                            plusOnes = Math.max(0, Math.min(attacks, plusOnes));

                            let critSuccess = 0;
                            let critFail = 0;

                            const rolls = [];
                            for (let i = 1; i <= attacks; i++) {
                                const bonus = baseBonus + (i <= plusOnes ? 1 : 0);
                                const atkRollFormula = mode === "adv" ? "2d20kh" : mode === "disadv" ? "2d20kl" : "1d20";

                                const d20 = await new Roll(atkRollFormula).evaluate({ async: true });
                                const nat = d20.total;
                                const atkTotal = nat + bonus;

                                let outcome = "normal";
                                let dmgTotal = 0;
                                let dmgFormula = "";

                                if (nat === 1) {
                                    outcome = "critFail";
                                    critFail++;
                                    dmgFormula = "-";
                                } else if (nat === 20) {
                                    outcome = "crit";
                                    critSuccess++;
                                    dmgFormula = doubleDiceFormula(dmgBase) ?? dmgBase;
                                    dmgTotal = (await new Roll(dmgFormula).evaluate({ async: true })).total;
                                } else {
                                    dmgFormula = dmgBase;
                                    dmgTotal = (await new Roll(dmgFormula).evaluate({ async: true })).total;
                                }

                                rolls.push({ i, bonus, nat, atkTotal, outcome, dmgFormula, dmgTotal, atkRollFormula });
                            }

                            const modeLabel = mode === "adv" ? "Avantage" : mode === "disadv" ? "Désavantage" : "Normal";

                            let content = `<h3>💀 Squelettes → Résultat selon CA</h3>`;
                            content += `<p>
                  <b>Nombre :</b> ${attacks}<br>
                  <b>Bonus :</b> +${baseBonus}<br>
                  <b>Assisted Aim :</b> ${plusOnes}<br>
                  <b>Dégâts :</b> ${dmgBase}<br>
                  <b>Mode :</b> ${modeLabel}
                </p>`;

                            content += `<details><summary><b>Voir les jets</b></summary><ul style="margin-top:8px;">`;
                            for (const r of rolls) {
                                const tag = r.outcome === "crit" ? "✅ Critique" : r.outcome === "critFail" ? "❌ Échec critique" : "";
                                content += `<li>
                    Attaque ${r.i} : d20=${r.nat} (${r.atkRollFormula} + ${r.bonus}) → <b>${r.atkTotal}</b> ${tag}
                    <br>Dégâts : ${r.dmgFormula === "-" ? "-" : `${r.dmgFormula} = ${r.dmgTotal}`}
                  </li>`;
                            }
                            content += `</ul></details><br>`;

                            content += `<table border="1" style="width:100%; text-align:center;">
                  <tr><th>CA</th><th>Touches</th><th>Dégâts totaux</th></tr>`;

                            const realAcMin = Math.min(acMin, acMax);
                            const realAcMax = Math.max(acMin, acMax);

                            for (let ac = realAcMin; ac <= realAcMax; ac++) {
                                let hits = 0, totalDmg = 0;
                                for (const r of rolls) {
                                    const hit = (r.nat === 20) ? true : (r.nat === 1) ? false : (r.atkTotal >= ac);
                                    if (hit) { hits++; totalDmg += r.dmgTotal; }
                                }
                                content += `<tr><td>${ac}</td><td>${hits}/${attacks}</td><td>${totalDmg}</td></tr>`;
                            }

                            content += `</table><br><b>Critiques :</b> ${critSuccess}<br><b>Échecs critiques :</b> ${critFail}`;
                            ChatMessage.create({ content });
                            return;
                        }
                    }
                );
            },
            close: () => {
                const pos = dlg?.position ?? {};
                managerWindowState = {
                    left: Number.isFinite(pos.left) ? pos.left : managerWindowState?.left,
                    top: Number.isFinite(pos.top) ? pos.top : managerWindowState?.top,
                    width: Number.isFinite(pos.width) ? pos.width : (managerWindowState?.width ?? 760),
                    height: Number.isFinite(pos.height) ? pos.height : (managerWindowState?.height ?? 560)
                };
                cleanupHooks();
                clearTimeout(refreshTimer);
            }
        });

        dlg.render(true);
  } catch (error) {
    console.error("Necromancer Manager | Erreur", error);
    ui.notifications.error(`Necromancer Manager : ${error?.message ?? error}`);
  } finally {
    opening = false;
  }
}

Hooks.once("init", () => {
  console.log("Necromancer Manager | Initialisation");

  const choices = roleChoices();
  for (const [key, name] of Object.entries(PERMISSION_SETTINGS)) {
    const isAccessPermission = key === "accessSetup";
    game.settings.register(MODULE_ID, key, {
      name,
      hint: isAccessPermission
        ? "Rôle minimal autorisé à afficher l'onglet Groupes et créatures. None interdit entièrement l'accès."
        : "Rôle minimal autorisé. Les choix plus permissifs que l'accès à l'onglet sont automatiquement bloqués.",
      scope: "world",
      config: true,
      type: Number,
      choices,
      default: CONST.USER_ROLES.PLAYER,
      onChange: async () => {
        await enforcePermissionHierarchy(key);
        scheduleReloadPrompt();
      }
    });
  }

  game.settings.register(MODULE_ID, "tokenScaleIncrement", {
    name: "Agrandissement par palier",
    hint: "Valeur ajoutée à la largeur et à la hauteur du token à chaque palier. Une valeur de 0,15 est recommandée.",
    scope: "world",
    config: true,
    type: Number,
    default: 0.15,
    onChange: () => scheduleAllGroupTokenSyncs()
  });

  game.settings.register(MODULE_ID, "tokenScaleEvery", {
    name: "Créatures par palier",
    hint: "Nombre de créatures actives nécessaire avant chaque nouvel agrandissement du token.",
    scope: "world",
    config: true,
    type: Number,
    default: 1,
    onChange: () => scheduleAllGroupTokenSyncs()
  });

  globalThis.NecromancerManager = {
    open: openNecromancerManager
  };
});

Hooks.on("renderSettingsConfig", (_app, html) => {
  try {
    const root = html instanceof jQuery ? html : $(html);
    const accessSelect = root.find('select[name="necromancer-manager.accessSetup"]');
    if (!accessSelect.length) return;

    const childKeys = Object.keys(PERMISSION_SETTINGS).filter(key => key !== "accessSetup");

    const refreshPermissionChoices = () => {
      const accessMinimum = Number(accessSelect.val());
      for (const key of childKeys) {
        const select = root.find(`select[name="necromancer-manager.${key}"]`);
        if (!select.length) continue;

        select.find("option").each((_index, option) => {
          const value = Number(option.value);
          option.disabled = value < accessMinimum;
        });

        if (Number(select.val()) < accessMinimum) select.val(String(accessMinimum));
      }
    };

    accessSelect.on("change.necromancerManager", refreshPermissionChoices);
    refreshPermissionChoices();
  } catch (error) {
    console.warn("Necromancer Manager | Impossible d'adapter les choix de permissions", error);
  }
});

const groupTokenSyncTimers = new Map();

function scheduleGroupTokenSyncForMember(memberActor) {
  if (Number(game.user?.role) !== CONST.USER_ROLES.GAMEMASTER || !memberActor || memberActor.getFlag(MODULE_ID, "groupToken")) return;
  for (const groupActor of game.actors?.filter(actor => actor.type === "group") ?? []) {
    const tokenActorId = groupActor.getFlag(MODULE_ID, "groupTokenActorId");
    if (!tokenActorId) continue;
    const refs = groupActor.getFlag(MODULE_ID, "managedMembers") ?? [];
    const containsMember = Array.isArray(refs) && refs.some(ref => actorIdFromMemberReference(ref) === memberActor.id);
    if (!containsMember) continue;
    clearTimeout(groupTokenSyncTimers.get(groupActor.id));
    groupTokenSyncTimers.set(groupActor.id, setTimeout(async () => {
      groupTokenSyncTimers.delete(groupActor.id);
      try {
        const ownerUserId = groupActor.getFlag(MODULE_ID, "ownerUserId");
        const ownerUser = game.users.get(ownerUserId);
        if (!ownerUser) return;
        const settings = (await ownerUser.getFlag("world", "skeletorsMacro")) ?? {};
        const group = (settings.groups ?? []).find(entry => entry.actorId === groupActor.id);
        if (group) await gmCreateOrUpdateGroupToken(ownerUser, group, settings);
      } catch (error) {
        console.debug("Necromancer Manager | Mise à jour automatique du token ignorée", error);
      }
    }, 250));
  }
}

let allGroupTokenSyncTimer = null;
function scheduleAllGroupTokenSyncs() {
  if (!game.ready || Number(game.user?.role) !== CONST.USER_ROLES.GAMEMASTER) return;
  clearTimeout(allGroupTokenSyncTimer);
  allGroupTokenSyncTimer = setTimeout(async () => {
    for (const groupActor of game.actors?.filter(actor => actor.type === "group") ?? []) {
      if (!groupActor.getFlag(MODULE_ID, "groupTokenActorId")) continue;
      try {
        const ownerUser = game.users.get(groupActor.getFlag(MODULE_ID, "ownerUserId"));
        if (!ownerUser) continue;
        const settings = (await ownerUser.getFlag("world", "skeletorsMacro")) ?? {};
        const group = (settings.groups ?? []).find(entry => entry.actorId === groupActor.id);
        if (group) await gmCreateOrUpdateGroupToken(ownerUser, group, settings);
      } catch (error) {
        console.debug("Necromancer Manager | Resynchronisation globale ignorée", error);
      }
    }
  }, 150);
}

Hooks.on("updateActor", actor => scheduleGroupTokenSyncForMember(actor));
Hooks.on("deleteActor", actor => scheduleGroupTokenSyncForMember(actor));
Hooks.on("updateToken", tokenDoc => {
  const actor = tokenDoc?.actor ?? (tokenDoc?.actorId ? game.actors.get(tokenDoc.actorId) : null);
  if (actor && !actor.getFlag(MODULE_ID, "groupToken")) scheduleGroupTokenSyncForMember(actor);
});

Hooks.once("ready", async () => {
  game.socket.on(SOCKET_CHANNEL, async payload => {
    if (payload?.type === "response" && payload.requesterId === game.user.id) {
      const pending = pendingGMRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      clearInterval(pending.retry);
      pendingGMRequests.delete(payload.requestId);
      if (payload.ok) pending.resolve(payload.result);
      else pending.reject(new Error(payload.error || "L’action demandée a échoué."));
      return;
    }

    const isFullGM = Number(game.user.role) === CONST.USER_ROLES.GAMEMASTER;
    if (payload?.type !== "request" || !isFullGM || payload.targetGMId !== game.user.id) return;

    // Les requêtes sont renvoyées automatiquement tant que le joueur n'a pas
    // reçu de réponse. Le cache évite donc toute création ou suppression en
    // double et permet simplement de renvoyer la même réponse.
    const cached = processedGMRequests.get(payload.requestId);
    if (cached) {
      game.socket.emit(SOCKET_CHANNEL, cached);
      return;
    }

    let response;
    try {
      const result = await executeGMOperation(payload.action, payload.data ?? {}, payload.requesterId);
      response = { type: "response", requestId: payload.requestId, requesterId: payload.requesterId, ok: true, result };
    } catch (error) {
      console.error("Necromancer Manager | Opération automatique GM", error);
      response = { type: "response", requestId: payload.requestId, requesterId: payload.requesterId, ok: false, error: error?.message ?? String(error) };
    }

    processedGMRequests.set(payload.requestId, response);
    setTimeout(() => processedGMRequests.delete(payload.requestId), 60000);
    game.socket.emit(SOCKET_CHANNEL, response);
  });

  game.necromancerManager = {
    open: openNecromancerManager
  };

  await enforcePermissionHierarchy();
  console.log("Necromancer Manager | Prêt");
});

Hooks.on("getSceneControlButtons", controls => {
  try {
    const tokenControls = Array.isArray(controls)
      ? controls.find(control => control.name === "token")
      : controls?.tokens ?? controls?.token;

    if (!tokenControls) return;

    const tool = {
      name: "necromancer-manager",
      title: "Necromancer Manager",
      icon: "fas fa-skull",
      button: true,
      visible: true,
      onClick: () => openNecromancerManager()
    };

    if (Array.isArray(tokenControls.tools)) {
      if (!tokenControls.tools.some(existing => existing.name === tool.name)) {
        tokenControls.tools.push(tool);
      }
    } else if (tokenControls.tools && typeof tokenControls.tools === "object") {
      tokenControls.tools[tool.name] = tool;
    }
  } catch (error) {
    console.error("Necromancer Manager | Impossible d'ajouter le bouton", error);
  }
});
