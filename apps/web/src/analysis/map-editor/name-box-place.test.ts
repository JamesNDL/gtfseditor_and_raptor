// Where the name box sits on the map: centred just above the place it names, kept inside the
// map's edges, and below the place when there is no room above.
import { describe, expect, it } from 'vitest';
import { NAME_BOX_GAP, NAME_BOX_MARGIN, nameBoxPlace } from './name-box-place.ts';

const VIEW = { width: 1600, height: 900 };
const BOX = { width: 260, height: 90 };

describe('nameBoxPlace', () => {
  it('centres the box just above the place', () => {
    expect(nameBoxPlace({ x: 800, y: 500 }, BOX, VIEW)).toEqual({
      left: 800 - 130,
      top: 500 - NAME_BOX_GAP - 90,
      below: false,
    });
  });

  it('keeps the box inside the left and right edges', () => {
    expect(nameBoxPlace({ x: 20, y: 500 }, BOX, VIEW).left).toBe(NAME_BOX_MARGIN);
    expect(nameBoxPlace({ x: 1590, y: 500 }, BOX, VIEW).left).toBe(1600 - 260 - NAME_BOX_MARGIN);
  });

  it('puts the box below the place when there is no room above', () => {
    expect(nameBoxPlace({ x: 800, y: 60 }, BOX, VIEW)).toEqual({
      left: 670,
      top: 60 + NAME_BOX_GAP,
      below: true,
    });
  });

  it('keeps a place off the bottom of the map in view', () => {
    expect(nameBoxPlace({ x: 800, y: 2000 }, BOX, VIEW).top).toBe(900 - 90 - NAME_BOX_MARGIN);
  });

  it('keeps a place off the top of the map in view', () => {
    expect(nameBoxPlace({ x: 800, y: -500 }, BOX, VIEW).top).toBe(NAME_BOX_MARGIN);
  });
});
