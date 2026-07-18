import type { useCast } from "../hooks/useCast";

// The full cast controller shape, shared by every component that receives it.
// Derived from the hook's return type so it stays in sync without duplicating it.
export type Cast = ReturnType<typeof useCast>;
