import { ulid } from "ulid";

/** ULIDs are time-sortable and fixed length, so ids sort by creation and never clash as key prefixes. */
export const newId = (): string => ulid();
