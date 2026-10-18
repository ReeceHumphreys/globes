// Takram 0.19.1 expects the pre-r186 struct.layout API. Adapt only its imports;
// the globe and Three.js itself continue using the native r186 API.
export * from "three/tsl";
import { struct as nativeStruct } from "three/tsl";

export function struct(...args: Parameters<typeof nativeStruct>): ReturnType<typeof nativeStruct> {
  const constructor = nativeStruct(...args);
  const layout = (constructor() as unknown as { structTypeNode: unknown }).structTypeNode;
  return new Proxy(constructor, {
    get(target, key, receiver) {
      return key === "layout" ? layout : Reflect.get(target, key, receiver);
    },
    has(target, key) {
      return key === "layout" || Reflect.has(target, key);
    },
  });
}
