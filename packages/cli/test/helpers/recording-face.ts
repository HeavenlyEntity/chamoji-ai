import type {Face, StepOutcome} from '../../src/face.js';

export type FaceCall =
	| ['step', string]
	| ['update', string]
	| ['end', StepOutcome, string]
	| ['stop'];

/** A face that draws nothing and logs every call made to it, in order. */
export function recordingFace(): {face: Face; calls: FaceCall[]} {
	const calls: FaceCall[] = [];
	const face: Face = {
		step(label) {
			calls.push(['step', label]);
			return {
				update(next) {
					calls.push(['update', next]);
				},
				end(outcome, text) {
					calls.push(['end', outcome, text]);
				},
			};
		},
		wrap: write => write,
		stop() {
			calls.push(['stop']);
		},
	};
	return {face, calls};
}
