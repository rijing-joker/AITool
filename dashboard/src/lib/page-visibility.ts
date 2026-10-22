/** Native hosts report visibility independently of the embedded document. */
let nativeVisible = true;
if (typeof window !== "undefined") {
  window.addEventListener("native:visibility", event => {
    const visible = (event as CustomEvent).detail?.visible;
    if (typeof visible !== "boolean") return;
    nativeVisible = visible;
    window.dispatchEvent(new Event("page:visibility"));
  });
}
export function isPageVisible(documentRef: Pick<Document, "visibilityState"> = document) {
  return nativeVisible && documentRef.visibilityState === "visible";
}
