import { BODIES, BODY_IDS, type BodyId } from "./bodies.ts";

/** A small HTML panel: which body to show, what to toggle on it, and its stats. */
export function createPanel(body: BodyId, onBody: (id: BodyId) => void) {
  const panel = document.createElement("aside");
  panel.className = "panel";
  const bodies = document.createElement("p");
  const layers = document.createElement("p");
  const [notice, credit, stats] = ["small", "small", "small"].map((tag) =>
    document.createElement(tag),
  );
  const buttons = BODY_IDS.map((id) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = BODIES[id].name;
    button.onclick = () => onBody(id);
    return button;
  });
  const select = (id: BodyId) =>
    buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(BODY_IDS[i] === id)));
  bodies.append(...buttons);
  panel.append(bodies, layers, notice, credit, stats);
  document.body.append(panel);
  select(body);

  return {
    /** Show a body's toggles. Each one flips an object's `visible`. */
    show(id: BodyId, toggles: { name: string; object: { visible: boolean } }[]) {
      select(id);
      const shown = BODIES[id];
      credit.textContent = "credit" in shown ? shown.credit : "";
      layers.replaceChildren(
        ...toggles.map(({ name, object }) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = name;
          button.setAttribute("aria-pressed", String(object.visible));
          button.onclick = () => {
            object.visible = !object.visible;
            button.setAttribute("aria-pressed", String(object.visible));
          };
          return button;
        }),
      );
    },
    setNotice: (text: string) => (notice.textContent = text),
    setStats: (text: string) => (stats.textContent = text),
  };
}
