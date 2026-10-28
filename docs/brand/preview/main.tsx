import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChamojiFoil, ChamojiPlate} from '../components/ChamojiFoil.js';

function Preview() {
	return (
		<main>
			<section className="hero">
				<div className="hero-content">
					<ChamojiPlate height={170} />
					<p className="tagline">Every commit explains itself.</p>
				</div>
			</section>

			<section className="panel">
				<h2>Full-bleed foil</h2>
				<ChamojiFoil className="bleed" fade={0.2} />
			</section>

			<section className="panel">
				<h2>Light</h2>
				<div className="row">
					<button className="foil-button">Ship workstream</button>
					<div className="card">
						<strong>🔐 Auth revamp</strong>
						<small>12 commits · 3 PRs · ready to ship</small>
					</div>
				</div>
			</section>

			<section className="panel dark">
				<h2>Dark</h2>
				<div className="row">
					<ChamojiFoil className="badge" stir={0} clickSwirl={false} sheen={0}>
						<span>Active: auth-revamp</span>
					</ChamojiFoil>
					<div className="card">
						<strong>⬆️ 9 dependency updates</strong>
						<small>jest, vite, @babel/core and 4 more</small>
					</div>
				</div>
			</section>

			<section className="panel">
				<h2>Display type: Marow Block</h2>
				<p className="display">chamoji 0.4.0</p>
				<p className="display small">workstreams · memory · review</p>
			</section>
		</main>
	);
}

createRoot(document.getElementById('root')!).render(<Preview />);
