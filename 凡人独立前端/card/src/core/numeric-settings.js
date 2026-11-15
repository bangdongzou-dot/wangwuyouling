let activeTables = new Map();

export function numericSetting(id, row) {
  return activeTables.get(id)?.get(row);
}

export function applyNumericSettings(tables) {
  activeTables = tables;
}
