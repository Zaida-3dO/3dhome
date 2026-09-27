/**
 * lib-cabinet-presets.mjs - the cabinet presets the Cabinet spec page offers
 * (specs/CabinetSpec.html PRESETS), for the Node tests. Keep the two in step:
 * a preset added to the page and not here is a preset no z-fighting, cap or
 * contract test ever builds.
 */
export const CABINET_PRESETS = {
  mirroredWardrobe2Door: {
    label: '2-door mirrored wardrobe',
    params: {
      width: 100, height: 236, depth: 60,
      fronts: [{ height: 228, cells: [
        { kind: 'mirror', width: 50 },
        { kind: 'mirror', width: 50 }
      ] }],
      plinth: { type: 'plinth', height: 8 },
      gloss: false, color: '#f2f0ec', topColor: '#f2f0ec'
    }
  },
  slidingWardrobe4Panel: {
    label: '2-door sliding wardrobe, 4-panel doors',
    params: {
      width: 150, height: 236, depth: 60,
      fronts: [{ height: 228, cells: [
        { kind: 'sliding', width: 150, doors: 2, panels: ['white', 'mirror', 'mirror', 'white'] }
      ] }],
      plinth: { type: 'plinth', height: 8 },
      gloss: false, color: '#ffffff', topColor: '#ffffff'
    }
  },
  tallDisplayCabinet: {
    label: 'Tall display cabinet',
    params: {
      width: 80, height: 189, depth: 34,
      fronts: [
        { height: 189, cells: [
          { kind: 'door', width: 29 },
          { kind: 'open', width: 1 },
          { kind: 'stack', width: 50, cells: [
            { kind: 'door', height: 32 },
            { kind: 'glass', height: 125, interior: {
              lining: '#2b2426', shelves: [35, 80], ledStrip: { color: '#ff4fa0' }, contents: 'books-games'
            } },
            { kind: 'door', height: 32 }
          ] }
        ] }
      ],
      plinth: { type: 'plinth', height: 0 },
      gloss: true, color: '#ffffff', topColor: '#ffffff',
      overlayFronts: true,
      glassSidePanel: {
        side: 'right',
        bands: [{}, { height: 125, glassDepth: 13, woodDepth: 20 }, {}]
      }
    }
  },
  tallDisplayCabinetMirror: {
    label: 'Tall display cabinet, mirror image (console)',
    params: {
      width: 80, height: 189, depth: 34,
      fronts: [
        { height: 189, cells: [
          { kind: 'stack', width: 50, cells: [
            { kind: 'door', height: 32 },
            { kind: 'glass', height: 125, interior: {
              lining: '#2b2426', shelves: [35, 80], ledStrip: { color: '#ff4fa0' }, contents: 'console'
            } },
            { kind: 'door', height: 32 }
          ] },
          { kind: 'open', width: 1 },
          { kind: 'door', width: 29 }
        ] }
      ],
      plinth: { type: 'plinth', height: 0 },
      gloss: true, color: '#ffffff', topColor: '#ffffff',
      overlayFronts: true,
      glassSidePanel: {
        side: 'left',
        bands: [{}, { height: 125, glassDepth: 13, woodDepth: 20 }, {}]
      }
    }
  },
  tvConsole: {
    label: 'TV console',
    params: {
      width: 180, height: 34, depth: 40,
      fronts: [
        { height: 34, cells: [
          { kind: 'door', width: 50 },
          { kind: 'stack', width: 80, cells: [
            { kind: 'open', height: 14 },
            { kind: 'drawer', height: 20 }
          ] },
          { kind: 'door', width: 50 }
        ] }
      ],
      plinth: { type: 'plinth', height: 0 },
      gloss: true, color: '#ffffff', topColor: '#2a2a2a'
    }
  },
  chestOfDrawers: {
    label: 'Chest of drawers',
    params: {
      width: 80, height: 122, depth: 48,
      fronts: [
        { height: 26, cells: [
          { kind: 'drawer', width: 40, handle: false },
          { kind: 'drawer', width: 40, handle: false }
        ] },
        { height: 22, cells: [{ kind: 'drawer', width: 80, handle: false }] },
        { height: 22, cells: [{ kind: 'drawer', width: 80, handle: false }] },
        { height: 22, cells: [{ kind: 'drawer', width: 80, handle: false }] },
        { height: 22, cells: [{ kind: 'drawer', width: 80, handle: false }] }
      ],
      plinth: { type: 'plinth', height: 8 },
      gloss: false, color: '#ffffff', topColor: '#ffffff', handles: false
    }
  },
  bedsideTableLedNarrow: {
    label: 'Bedside table, LED drawers — narrow',
    params: {
      width: 24, height: 60, depth: 50,
      fronts: [
        { height: 21, cells: [{ kind: 'drawer', width: 24 }] },
        { height: 2, channel: { color: '#dbe8ff' } },
        { height: 18, cells: [{ kind: 'drawer', width: 24 }] },
        { height: 2, channel: { color: '#ffb347' } },
        { height: 15, cells: [{ kind: 'drawer', width: 24 }] }
      ],
      plinth: { type: 'plinth', height: 2, inset: 1 },
      finish: 'satin', handles: false, overlayFronts: true,
      color: '#ffffff', topColor: '#ffffff'
    }
  },
  bedsideTableLedWide: {
    label: 'Bedside table, LED drawers — wide',
    params: {
      width: 50, height: 60, depth: 40,
      fronts: [
        { height: 21, cells: [{ kind: 'drawer', width: 50 }] },
        { height: 2, channel: { color: '#dbe8ff' } },
        { height: 18, cells: [{ kind: 'drawer', width: 50 }] },
        { height: 2, channel: { color: '#ffb347' } },
        { height: 15, cells: [{ kind: 'drawer', width: 50 }] }
      ],
      plinth: { type: 'plinth', height: 2, inset: 1 },
      finish: 'satin', handles: false, overlayFronts: true,
      color: '#ffffff', topColor: '#ffffff'
    }
  },
  mobilePedestal: {
    label: 'Mobile pedestal',
    params: {
      width: 40, height: 60, depth: 45,
      fronts: [
        { height: 18, cells: [{ kind: 'drawer' }] },
        { height: 18, cells: [{ kind: 'drawer' }] },
        { height: 19, cells: [{ kind: 'drawer' }] }
      ],
      plinth: { type: 'wheels', height: 5 },
      gloss: false, color: '#ffffff', topColor: '#ffffff'
    }
  },
  openShelving2Columns: {
    label: 'Open shelving unit, 2 columns (56/33)',
    params: {
      width: 95, height: 140, depth: 39, panelThickness: 2,
      columns: [
        { width: 56, rows: 4 },
        { width: 33, rows: 4 }
      ],
      plinth: { type: 'plinth', height: 0 },
      gloss: false, color: '#ffffff', topColor: '#ffffff'
    }
  },
  // Not on the page: the two mirror cabinets a real bathroom profile uses
  // (generic sizes), so the live house's own shape is covered.
  bathroomMirrorCabinet3Door: {
    label: '(test only) 3-door mirror cabinet, handleless',
    params: {
      width: 120, height: 72, depth: 18, plinth: { type: 'plinth', height: 0 }, handles: false,
      color: '#f4f1ea', topColor: '#f4f1ea',
      fronts: [{ height: 72, cells: [{ kind: 'mirror', width: 40 }, { kind: 'mirror', width: 40 }, { kind: 'mirror', width: 40 }] }]
    }
  }
};
