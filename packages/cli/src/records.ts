/** A JSON object, as opposed to an array, null or a scalar. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A property the object itself has, never one inherited from the prototype. */
export const own = (record: Record<string, unknown>, key: string): unknown =>
	Object.hasOwn(record, key) ? record[key] : undefined;
