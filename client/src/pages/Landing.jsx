import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import ECellLogo from '../components/ECellLogo.jsx';
import HeroScene from '../components/landing/HeroScene.jsx';
import { initScrollReveal } from '../lib/scrollReveal.js';
import '../landing.css';

const STAGES = [
  {
    key: 'idea-lab',
    n: '01',
    title: 'Idea Lab',
    tone: 'green',
    blurb: 'Reveal your company identity — market, customer, mission and resource cards that define who you are in the Mayhemverse.',
  },
  {
    key: 'action-cards',
    n: '02',
    title: 'Action Cards',
    tone: 'cyan',
    blurb: 'Draft a hand of moves from a battle-arena catalogue and play them to grow, defend or outmanoeuvre rival companies.',
  },
  {
    key: 'marketplace',
    n: '03',
    title: 'Marketplace',
    tone: 'amber',
    blurb: 'Step onto the trading floor. Offer, request and swap cards with other teams to build the hand you actually need.',
  },
  {
    key: 'market-mayhem',
    n: '04',
    title: 'Market Mayhem',
    tone: 'red',
    blurb: 'Live crises hit the arena without warning. Some teams are affected, some are safe — react fast or take the hit.',
  },
  {
    key: 'funding',
    n: '05',
    title: 'Funding',
    tone: 'amber',
    blurb: 'Prove your traction to the investor tower. Resources and reputation earned across the game decide who gets backed.',
  },
  {
    key: 'final-pitch',
    n: '06',
    title: 'Final Pitch',
    tone: 'green',
    blurb: 'One spotlight, one arena. The surviving companies make their case for who built the strongest startup.',
  },
];

const TIMELINE = [
  { label: 'Gates Open', detail: 'Teams check in and receive their company identity.' },
  { label: 'Round 1 — Idea Lab', detail: 'Identity cards revealed. Company foundations are set.' },
  { label: 'Round 2 — Action Cards', detail: 'Teams draft and play action cards to grow their startup.' },
  { label: 'Round 3 — Market Mayhem', detail: 'Live crises strike. Marketplace trading stays open throughout.' },
  { label: 'Final Pitch', detail: 'Surviving companies pitch for the win in the final arena.' },
];

const RULES = [
  'Every team plays as one company for the entire event — there are no substitutions once the Mayhemverse opens.',
  'Action cards, trades and crisis responses are resolved by the platform in real time; decisions made in the arena are final.',
  'Marketplace trades are between two consenting teams only — no team can be forced into a trade.',
  'Market Mayhem crises can affect any team at any time. Some cards and trades exist specifically to protect against them.',
  'Respect the arena: no interfering with another team\'s device, account, or in-game resources outside the rules of the game.',
];

function Section({ id, className = '', children }) {
  return (
    <section id={id} className={`lv-section ${className}`}>
      {children}
    </section>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  const rootRef = useRef(null);

  useEffect(() => {
    const cleanup = initScrollReveal(rootRef.current);
    return cleanup;
  }, []);

  return (
    <div className="landing-root" ref={rootRef}>
      <header className="lv-nav">
        <div className="lv-nav-brand"><ECellLogo size={30} /> E-CELL <span>NIT TRICHY</span></div>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/login')}>Log In</button>
      </header>

      <Section id="hero" className="lv-hero">
        <HeroScene />
        <div className="lv-hero-content">
          <div className="lv-hero-logo" data-reveal><ECellLogo size={72} /></div>
          <div className="lv-eyebrow" data-reveal>E-CELL NIT TRICHY PRESENTS</div>
          <h1 className="lv-title" data-reveal>
            STARTUP MAYHEM <span className="lv-title-accent">&apos;26</span>
          </h1>
          <div className="lv-subtitle" data-reveal>THE MAYHEMVERSE</div>
          <p className="lv-tagline" data-reveal>Build. Battle. Survive.</p>
          <p className="lv-desc" data-reveal>
            Step into a live startup battle arena where ~30 teams run real companies,
            trade for advantage, and fight through market crises to the final pitch.
          </p>
          <button className="btn btn-primary lv-cta" data-reveal onClick={() => navigate('/login')}>
            Enter the Mayhemverse
          </button>
        </div>
      </Section>

      <Section id="mayhemverse" className="lv-narrow">
        <div className="lv-kicker" data-reveal>THE MAYHEMVERSE</div>
        <h2 className="lv-h2" data-reveal>A startup universe built to break under pressure</h2>
        <p className="lv-lead" data-reveal>
          Every team enters as a founding company with its own identity, resources and mission.
          What happens next — who trades, who survives Market Mayhem, who makes the final pitch —
          is entirely in your hands. This isn't a simulation you watch. It's one you run.
        </p>
      </Section>

      <Section id="how" className="lv-narrow">
        <div className="lv-kicker" data-reveal>HOW THE GAME WORKS</div>
        <h2 className="lv-h2" data-reveal>Six stages. One surviving company.</h2>
        <div className="lv-how-grid">
          {[
            { title: 'Get Your Company', body: 'Log in as your team and reveal your identity cards.' },
            { title: 'Grow & Trade', body: 'Play action cards and trade with other teams to strengthen your position.' },
            { title: 'Survive the Mayhem', body: 'React to live crises before they cost your company resources.' },
            { title: 'Pitch to Win', body: 'Carry your resources and reputation into the final pitch arena.' },
          ].map((s) => (
            <div className="lv-how-card" key={s.title} data-reveal>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="stages" className="lv-stages">
        <div className="lv-kicker" data-reveal>THE SIX GAME STAGES</div>
        <h2 className="lv-h2" data-reveal>Every stage, its own arena</h2>
        <div className="lv-stage-grid">
          {STAGES.map((s) => (
            <div className={`lv-stage-card tone-${s.tone}`} key={s.key} data-reveal>
              <div className="lv-stage-n">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.blurb}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="action-cards" className="lv-split">
        <div className="lv-split-text" data-reveal>
          <div className="lv-kicker tone-cyan">ACTION CARDS</div>
          <h2 className="lv-h2">A battle arena of floating cards</h2>
          <p className="lv-lead">
            Draft cards across action, deal and special categories. Every play shifts your
            company's cash, customers, reputation or innovation — read the board, then strike.
          </p>
        </div>
        <div className="lv-split-visual tone-cyan" data-reveal aria-hidden="true">
          <div className="lv-ghost-card c1" />
          <div className="lv-ghost-card c2" />
          <div className="lv-ghost-card c3" />
        </div>
      </Section>

      <Section id="marketplace" className="lv-split reverse">
        <div className="lv-split-visual tone-amber" data-reveal aria-hidden="true">
          <div className="lv-trade-glow" />
        </div>
        <div className="lv-split-text" data-reveal>
          <div className="lv-kicker tone-amber">MARKETPLACE</div>
          <h2 className="lv-h2">A futuristic trading floor</h2>
          <p className="lv-lead">
            List what you don't need. Request what you do. Every trade is between two teams,
            settled instantly — no waiting, no middleman.
          </p>
        </div>
      </Section>

      <Section id="market-mayhem" className="lv-mayhem">
        <div className="lv-mayhem-core" data-reveal aria-hidden="true" />
        <div className="lv-mayhem-text" data-reveal>
          <div className="lv-kicker tone-red">MARKET MAYHEM</div>
          <h2 className="lv-h2">The core is unstable</h2>
          <p className="lv-lead">
            Without warning, a crisis rips through the market. Some companies are hit hard,
            some are protected, some walk away untouched. Whether you survive depends on the
            cards you drafted and the trades you made before it hit.
          </p>
        </div>
      </Section>

      <Section id="timeline" className="lv-narrow">
        <div className="lv-kicker" data-reveal>EVENT TIMELINE</div>
        <h2 className="lv-h2" data-reveal>The run of play</h2>
        <div className="lv-timeline">
          {TIMELINE.map((t, i) => (
            <div className="lv-timeline-item" key={t.label} data-reveal>
              <div className="lv-timeline-dot">{i + 1}</div>
              <div>
                <h3>{t.label}</h3>
                <p>{t.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="rules" className="lv-narrow">
        <div className="lv-kicker" data-reveal>RULES</div>
        <h2 className="lv-h2" data-reveal>The arena runs on these</h2>
        <ul className="lv-rules-list">
          {RULES.map((r) => (
            <li key={r} data-reveal>{r}</li>
          ))}
        </ul>
      </Section>

      <Section id="enter" className="lv-final-cta">
        <h2 className="lv-h2" data-reveal>Your company is waiting.</h2>
        <p className="lv-lead" data-reveal>Log in with your team credentials to enter the Mayhemverse.</p>
        <button className="btn btn-primary lv-cta" data-reveal onClick={() => navigate('/login')}>
          Enter the Game
        </button>
      </Section>

      <footer className="lv-footer">
        <p>E-Cell NIT Trichy · Startup Mayhem &apos;26</p>
      </footer>
    </div>
  );
}
