import React from 'react';
import Iridescence, {type IridescenceProps} from './Iridescence.js';

/**
 * Chamoji's tuning of Iridescence: pale, pastel and slow, to match the
 * holographic logo plate (see docs/brand/BRAND.md). Start from these and
 * override per surface rather than re-tuning from the component defaults.
 */
export const CHAMOJI_FOIL: IridescenceProps = {
	color: '#fff1ea',
	hueShift: -12,
	saturation: 0.9,
	brightness: 1.12,
	contrast: 0.9,
	speed: 0.35,
	scale: 1.25,
	detail: 8,
	warp: 1,
	amplitude: 0.08,
	stir: 0.4,
	sheen: 0.3,
	clickSwirl: true,
	grain: 0.04,
};

type FoilProps = IridescenceProps & {children?: React.ReactNode};

/**
 * A surface of moving foil with content on top. The CSS `--holo` gradient
 * sits underneath, so the surface still looks right where WebGL2 is missing
 * or the canvas hasn't drawn yet.
 */
export function ChamojiFoil({
	children,
	className = '',
	style,
	...overrides
}: FoilProps) {
	return (
		<div
			className={`chamoji-foil ${className}`.trim()}
			style={{
				position: 'relative',
				overflow: 'hidden',
				background: 'var(--holo)',
				...style,
			}}
		>
			<Iridescence
				{...CHAMOJI_FOIL}
				{...overrides}
				style={{position: 'absolute', inset: 0}}
			/>
			{children ? (
				<div style={{position: 'relative', height: '100%'}}>{children}</div>
			) : null}
		</div>
	);
}

/** The logo plate: a 35° foil parallelogram with the Marow Block wordmark. */
export function ChamojiPlate({
	height = 180,
	label = 'chamoji',
}: {
	height?: number;
	label?: string;
}) {
	return (
		<div
			style={{
				transform: 'skewX(-35deg)',
				height,
				margin: `0 ${Math.round(height * 0.45)}px`,
			}}
		>
			<ChamojiFoil style={{height: '100%'}}>
				<div
					style={{
						height: '100%',
						display: 'grid',
						placeItems: 'center',
						transform: 'skewX(35deg)',
						fontFamily: 'var(--font-display)',
						fontSize: height * 0.36,
						letterSpacing: '0.04em',
						color: 'var(--ink)',
						userSelect: 'none',
					}}
				>
					{label}
				</div>
			</ChamojiFoil>
		</div>
	);
}
