import { useState } from "react";
import { SCENARIOS } from "./tutorData";
import "./TutorPanel.css";

const STEP_LABELS = ["Patient Story", "CRF Form", "Which Domain?", "CRF → SDTM", "FDA Submission", "Review Quiz"];
const STORAGE_KEY = "cdisc-tutor";

/* ─────────────── Scenario list (landing) ─────────────── */

function ScenarioList({ done, onStart }) {
  return (
    <div className="tp-list">
      <div className="tp-list-hdr">
        <h2>SDTM Mapping Tutorial</h2>
        <p className="tp-list-sub">
          Learn how clinical data flows from a patient event to an FDA submission — step by step.
        </p>
        <p className="tp-list-src">
          Scenarios based on the <strong>CDISC Pilot Study (CDISCPILOT01)</strong> — the canonical
          open-source clinical trial dataset published by CDISC for educational use.
        </p>
      </div>
      <div className="tp-grid">
        {SCENARIOS.map((sc) => {
          const isDone = done.includes(sc.id);
          return (
            <button key={sc.id} className={`tp-card${isDone ? " tp-card-done" : ""}`} onClick={() => onStart(sc.id)}>
              <span className="tp-card-icon">{sc.icon}</span>
              <div className="tp-card-body">
                <div className="tp-card-title">{sc.title}</div>
                <div className="tp-card-sub">{sc.subtitle}</div>
                <div className="tp-card-meta">
                  <span className={`tp-diff tp-diff-${sc.difficulty.toLowerCase()}`}>{sc.difficulty}</span>
                  <span className="tp-domain-tag">{sc.domain}</span>
                  {isDone && <span className="tp-done-tag">✓ Done</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────── Step 0: Story ─────────────── */

function StoryStep({ data }) {
  return (
    <div className="tp-step-wrap">
      <h3>1 &middot; The Patient Event</h3>
      <div className="tp-patient-bar">
        <span className="tp-pid">{data.patient.id}</span>
        <span>{data.patient.age}y · {data.patient.sex}</span>
        <span className="tp-arm-tag">{data.patient.arm}</span>
      </div>
      <p className="tp-narrative">{data.narrative}</p>
      <div className="tp-facts">
        {data.keyFacts.map((f) => (
          <div key={f.label} className="tp-fact">
            <span className="tp-fact-l">{f.label}</span>
            <span className="tp-fact-v">{f.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────── Step 1: CRF ─────────────── */

function CRFStep({ data }) {
  const [openIdx, setOpenIdx] = useState(null);
  return (
    <div className="tp-step-wrap">
      <h3>2 &middot; The Case Report Form</h3>
      <p className="tp-desc">{data.description}</p>
      <div className="tp-crf-card">
        <div className="tp-crf-title">{data.title}</div>
        <div className="tp-crf-hdr"><span>Field</span><span>Value</span><span></span></div>
        {data.fields.map((f, i) => (
          <div key={i} className={`tp-crf-row${openIdx === i ? " open" : ""}`}>
            <div className="tp-crf-main" onClick={() => setOpenIdx(openIdx === i ? null : i)}>
              <span className="tp-crf-field">{f.label}</span>
              <span className="tp-crf-val">{f.value}</span>
              <span className="tp-crf-chevron">{openIdx === i ? "▾" : "Why? ▸"}</span>
            </div>
            {openIdx === i && <div className="tp-crf-why">{f.why}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────── Step 2: Domain quiz ─────────────── */

function DomainQuizStep({ data, pick, onPick }) {
  return (
    <div className="tp-step-wrap">
      <h3>3 &middot; Which Domain?</h3>
      <p className="tp-quiz-q">{data.question}</p>
      <div className="tp-quiz-opts">
        {data.options.map((o) => {
          const chosen = pick === o.domain;
          const show = pick !== null;
          let cls = "tp-quiz-opt";
          if (show) cls += o.correct ? " correct" : chosen ? " wrong" : " dim";
          return (
            <button key={o.domain} className={cls} onClick={() => !pick && onPick(o.domain)} disabled={!!pick}>
              <strong>{o.label}</strong>
              {show && <span className="tp-quiz-exp">{o.explanation}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────── Step 3: Mapping ─────────────── */

function MappingStep({ data, revealed, onReveal, onRevealAll }) {
  return (
    <div className="tp-step-wrap">
      <h3>4 &middot; CRF → SDTM Mapping</h3>
      <p className="tp-desc">{data.description}</p>
      <div className="tp-map-ctrl">
        <button className="tp-reveal-btn" onClick={onRevealAll}>Reveal All ({revealed.size}/{data.rows.length})</button>
      </div>
      <div className="tp-map-table">
        <div className="tp-map-hdr">
          <span className="tp-mh-src">Source</span>
          <span className="tp-mh-crf">CRF Field</span>
          <span className="tp-mh-arrow"></span>
          <span className="tp-mh-var">SDTM Variable</span>
          <span className="tp-mh-val">Value</span>
          <span className="tp-mh-xfm">Transform</span>
        </div>
        {data.rows.map((r, i) => {
          const open = revealed.has(i);
          return (
            <div key={i} className={`tp-map-row${open ? " open" : ""}`} onClick={() => onReveal(i)}>
              <div className="tp-map-main">
                <span className={`tp-map-src tp-src-${r.source.toLowerCase()}`}>{r.source}</span>
                <span className="tp-map-crf">{r.crfField}</span>
                <span className="tp-map-arrow">→</span>
                {open ? (
                  <>
                    <code className="tp-map-var">{r.sdtmVar}</code>
                    <span className="tp-map-val">{r.value}</span>
                    <span className="tp-map-xfm">{r.transform}</span>
                  </>
                ) : (
                  <span className="tp-map-hidden">Click to reveal</span>
                )}
              </div>
              {open && <div className="tp-map-exp">{r.explanation}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────── Step 4: Final row ─────────────── */

function FinalRowStep({ data }) {
  return (
    <div className="tp-step-wrap">
      <h3>5 &middot; The FDA Submission Row</h3>
      <p className="tp-desc">{data.description}</p>
      <div className="tp-final-scroll">
        <table className="tp-final-tbl">
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c} className={data.highlights[c] ? "hl" : ""}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {data.values.map((v, i) => (
                <td key={i} className={data.highlights[data.columns[i]] ? "hl" : ""}>{v}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="tp-hl-notes">
        <h4>Key Fields</h4>
        {Object.entries(data.highlights).map(([k, v]) => (
          <div key={k} className="tp-hl-note">
            <code>{k}</code>
            <span>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────── Step 5: Review quiz ─────────────── */

function ReviewQuizStep({ data, answers, onAnswer }) {
  const total = data.length;
  const answered = Object.keys(answers).length;
  const correct = Object.entries(answers).filter(([qi, ai]) => data[qi].options[ai].correct).length;

  return (
    <div className="tp-step-wrap">
      <h3>6 &middot; Test Your Knowledge</h3>
      {answered === total && (
        <div className={`tp-score ${correct === total ? "perfect" : ""}`}>
          Score: {correct}/{total}
          {correct === total ? " — Perfect!" : correct >= total - 1 ? " — Great job!" : " — Review the steps to reinforce."}
        </div>
      )}
      {data.map((q, qi) => {
        const picked = answers[qi];
        const show = picked !== undefined;
        return (
          <div key={qi} className="tp-rq-block">
            <p className="tp-rq-q">{qi + 1}. {q.question}</p>
            <div className="tp-rq-opts">
              {q.options.map((o, oi) => {
                let cls = "tp-rq-opt";
                if (show) cls += o.correct ? " correct" : picked === oi ? " wrong" : " dim";
                return (
                  <button key={oi} className={cls} onClick={() => !show && onAnswer(qi, oi)} disabled={show}>
                    {o.text}
                  </button>
                );
              })}
            </div>
            {show && <div className="tp-rq-exp">{q.explanation}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────── Main TutorPanel ─────────────── */

export default function TutorPanel() {
  const [view, setView] = useState("list");
  const [sid, setSid] = useState(null);
  const [step, setStep] = useState(0);
  const [domainPick, setDomainPick] = useState(null);
  const [revealed, setRevealed] = useState(new Set());
  const [quizAns, setQuizAns] = useState({});
  const [done, setDone] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
  });

  const sc = SCENARIOS.find((s) => s.id === sid);

  function start(id) {
    setSid(id);
    setStep(0);
    setDomainPick(null);
    setRevealed(new Set());
    setQuizAns({});
    setView("walk");
  }

  function finish() {
    if (!done.includes(sid)) {
      const next = [...done, sid];
      setDone(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
    setView("list");
  }

  if (view === "list") return <ScenarioList done={done} onStart={start} />;

  const canNext = step !== 2 || domainPick;

  return (
    <div className="tp-root">
      {/* Top bar */}
      <div className="tp-top">
        <button className="tp-back" onClick={() => setView("list")}>← Scenarios</button>
        <div className="tp-top-title">{sc.icon} {sc.title}</div>
        <div className="tp-steps">
          {STEP_LABELS.map((l, i) => (
            <button
              key={i}
              className={`tp-dot${i === step ? " active" : ""}${i < step ? " done" : ""}`}
              onClick={() => setStep(i)}
              title={l}
            >
              {i < step ? "✓" : i + 1}
            </button>
          ))}
        </div>
      </div>

      {/* Step content */}
      <div className="tp-body">
        {step === 0 && <StoryStep data={sc.story} />}
        {step === 1 && <CRFStep data={sc.crf} />}
        {step === 2 && <DomainQuizStep data={sc.domainQuiz} pick={domainPick} onPick={setDomainPick} />}
        {step === 3 && (
          <MappingStep
            data={sc.mapping}
            revealed={revealed}
            onReveal={(i) => setRevealed((s) => new Set([...s, i]))}
            onRevealAll={() => setRevealed(new Set(sc.mapping.rows.map((_, i) => i)))}
          />
        )}
        {step === 4 && <FinalRowStep data={sc.finalRow} />}
        {step === 5 && (
          <ReviewQuizStep
            data={sc.reviewQuiz}
            answers={quizAns}
            onAnswer={(qi, oi) => setQuizAns((a) => ({ ...a, [qi]: oi }))}
          />
        )}
      </div>

      {/* Nav */}
      <div className="tp-nav">
        {step > 0 && <button className="tp-nav-btn" onClick={() => setStep(step - 1)}>← Previous</button>}
        <div className="tp-nav-spacer" />
        {step < 5 ? (
          <button className="tp-nav-btn tp-nav-next" onClick={() => setStep(step + 1)} disabled={!canNext}>
            Next →
          </button>
        ) : (
          <button className="tp-nav-btn tp-nav-finish" onClick={finish}>Complete ✓</button>
        )}
      </div>
    </div>
  );
}
