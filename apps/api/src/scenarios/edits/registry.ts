// Every edit kind, by the name the editor sends as `kind`, with the function that applies it.
// Each kind's request body is the type of its function's last parameter, so adding an edit kind
// is one new file in edits/ and one line here.
import type { EditResult, Scenario, Tx } from '../engine.ts';
import { closureDeps, deleteStopDeps } from './deps.ts';
import { editAddCall } from './add-call.ts';
import { editAddStop } from './add-stop.ts';
import { editAddTrip } from './add-trip.ts';
import { editClose, type CloseBody } from './closure.ts';
import { editCreateLine } from './create-line.ts';
import { editDelete } from './delete.ts';
import { editDeleteLine } from './delete-line.ts';
import { editDeleteStop, type DeleteStopBody } from './delete-stop.ts';
import { editDuplicate } from './duplicate.ts';
import { editHeadway } from './headway.ts';
import { editLineFrequency } from './line-frequency.ts';
import { editMoveToVehicle } from './move-to-vehicle.ts';
import { editReplan } from './replan.ts';
import { editReshape } from './reshape.ts';
import { editSetPlatform } from './set-platform.ts';
import { editSetVehicle } from './set-vehicle.ts';
import { editSetVehicleType } from './set-vehicle-type.ts';
import { editShift } from './shift.ts';
import { editSkipStop } from './skip-stop.ts';

const EDIT_KINDS = {
  shift: editShift,
  delete: editDelete,
  deleteLine: editDeleteLine,
  duplicate: editDuplicate,
  skipStop: editSkipStop,
  headway: editHeadway,
  setVehicle: editSetVehicle,
  setVehicleType: editSetVehicleType,
  lineFrequency: editLineFrequency,
  createLine: editCreateLine,
  reshape: editReshape,
  addStop: editAddStop,
  setPlatform: editSetPlatform,
  replan: editReplan,
  moveToVehicle: editMoveToVehicle,
  addTrip: editAddTrip,
  addCall: editAddCall,
  close: (tx: Tx, sc: Scenario, seq: number, b: CloseBody) =>
    editClose(tx, sc, seq, b, closureDeps),
  deleteStop: (tx: Tx, sc: Scenario, seq: number, b: DeleteStopBody) =>
    editDeleteStop(tx, sc, seq, b, deleteStopDeps),
};

export type EditKind = keyof typeof EDIT_KINDS;

/** The request body of each edit kind. */
export type EditBodies = { [K in EditKind]: Parameters<(typeof EDIT_KINDS)[K]>[3] };

/**
 * What `POST /api/scenarios/:id/edits` is sent: the kind, its body, and `confirm: false` to have
 * an edit that adds many vehicles described rather than applied.
 */
export type EditRequest = {
  [K in EditKind]: { kind: K; confirm?: boolean } & EditBodies[K];
}[EditKind];

type EditFunctions = {
  [K in EditKind]: (tx: Tx, sc: Scenario, seq: number, body: EditBodies[K]) => Promise<EditResult>;
};
const editFunctions: EditFunctions = EDIT_KINDS;

/** Whether the editor sent a kind there is a function for. */
export const isEditKind = (kind: string): kind is EditKind => Object.hasOwn(EDIT_KINDS, kind);

/** Applies one edit of the given kind inside the edit's transaction. */
export const runEdit = <K extends EditKind>(
  kind: K,
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: EditBodies[K],
): Promise<EditResult> => editFunctions[kind](tx, sc, seq, body);
