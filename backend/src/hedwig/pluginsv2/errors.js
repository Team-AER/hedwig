// Errors the plugin runtime throws. PermissionError is part of the plugin-facing API (plugins can
// `instanceof hedwig.PermissionError`), so its shape is stable: { pluginId, permission, reason }.

export class PermissionError extends Error {
  constructor(pluginId, permission, reason = 'not granted') {
    super(`plugin ${pluginId}: permission ${permission} ${reason}`);
    this.name = 'PermissionError';
    this.status = 403;
    this.code = 'plugin_permission';
    this.pluginId = pluginId;
    this.permission = permission;
    this.reason = reason;
  }
}

export class ManifestError extends Error {
  constructor(errors, source = 'manifest') {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(`${source}: ${list.join('; ')}`);
    this.name = 'ManifestError';
    this.status = 400;
    this.code = 'plugin_manifest';
    this.errors = list;
  }
}

export class PluginInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginInputError';
    this.status = 400;
    this.code = 'plugin_input';
  }
}
