import { useId, useState, type ReactNode } from "react";
const SECTIONS = [
  { id: "overview", label: "经营概览" },
  { id: "shift", label: "交班" },
  { id: "reports", label: "历史报表与对账" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];
export function StatsSections({ overview, shift, reports }: Readonly<Record<Section, ReactNode>>) {
  const [selected, setSelected] = useState<Section>("overview");
  const id = useId();
  const panels = { overview, shift, reports };
  return (
    <>
      <div role="tablist" aria-label="账目分区" className="ld-stats-tabs">
        {SECTIONS.map((section, index) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            id={`${id}-${section.id}-tab`}
            aria-controls={`${id}-${section.id}-panel`}
            aria-selected={selected === section.id}
            tabIndex={selected === section.id ? 0 : -1}
            onClick={() => setSelected(section.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % SECTIONS.length
                  : event.key === "ArrowLeft"
                    ? (index + SECTIONS.length - 1) % SECTIONS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? SECTIONS.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              const target = SECTIONS[next];
              if (target !== undefined) {
                setSelected(target.id);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`[id="${id}-${target.id}-tab"]`)
                  ?.focus();
              }
            }}
          >
            {section.label}
          </button>
        ))}
      </div>
      {SECTIONS.map((section) => (
        <section
          key={section.id}
          role="tabpanel"
          id={`${id}-${section.id}-panel`}
          aria-labelledby={`${id}-${section.id}-tab`}
          hidden={selected !== section.id}
          tabIndex={0}
          className="ld-stats-section"
        >
          {panels[section.id]}
        </section>
      ))}
    </>
  );
}
