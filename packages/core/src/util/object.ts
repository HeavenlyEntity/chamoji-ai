/** A parsed JSON or YAML object. */
export type Obj = Record<string, unknown>;

/** A plain object, as opposed to an array, null or a scalar. */
export const isObject = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
