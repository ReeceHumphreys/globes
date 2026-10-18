import type { GlobeContext, GlobeFrame, GlobeLayer } from "./composition.ts";

const used = new WeakSet<GlobeLayer>();

/** Ordered lifecycle ownership, including removal during asynchronous attachment. */
export function createLayerHost(context: GlobeContext) {
  const entries = new Map<
    string,
    {
      layer: GlobeLayer;
      context: GlobeContext;
      controller: AbortController;
      attached: boolean;
      cleanup: () => void;
    }
  >();
  let disposed = false;
  function remove(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.controller.abort();
    if (entry.attached) entry.cleanup();
    context.requestRender();
  }
  return {
    async add(layer: GlobeLayer) {
      if (disposed) throw new Error("Globe is disposed");
      if (!layer.id || entries.has(layer.id))
        throw new Error(`Duplicate or empty layer id: ${layer.id}`);
      if (used.has(layer)) throw new Error("Layer instances cannot be attached twice");
      used.add(layer);
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) controller.abort();
      let cleaned = false;
      const entry = {
        layer,
        context: { ...context, signal: controller.signal },
        controller,
        attached: false,
        cleanup() {
          if (cleaned) return;
          cleaned = true;
          context.signal.removeEventListener("abort", abort);
          try {
            layer.dispose();
          } catch (error) {
            context.reportError(error);
          }
        },
      };
      entries.set(layer.id, entry);
      try {
        await layer.attach(entry.context);
        entry.attached = true;
        if (controller.signal.aborted) entry.cleanup();
        else context.requestRender();
      } catch (error) {
        if (entries.get(layer.id) === entry) entries.delete(layer.id);
        controller.abort();
        entry.cleanup();
        throw error;
      }
    },
    remove,
    prepare(now: number) {
      for (const entry of entries.values())
        if (entry.attached && !entry.controller.signal.aborted) entry.layer.prepare?.(now);
    },
    update(frame: GlobeFrame) {
      for (const entry of entries.values()) {
        if (entry.attached && !entry.controller.signal.aborted)
          entry.layer.update({
            ...frame,
            context: entry.context,
          });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...entries.keys()].reverse()) remove(id);
    },
  };
}
