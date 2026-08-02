const { enableViewTransitionsProto } = require("./featureFlags");

const supportsNativeViewTransitions = () => {
  if (typeof document === "undefined") return false;
  return typeof document.startViewTransition === "function";
};

const runWithOptionalViewTransition = (update) => {
  if (typeof update !== "function") return;

  if (!enableViewTransitionsProto || !supportsNativeViewTransitions()) {
    update();
    return;
  }

  try {
    document.startViewTransition(() => update());
  } catch {
    update();
  }
};

module.exports = {
  enableViewTransitionsProto,
  supportsNativeViewTransitions,
  runWithOptionalViewTransition,
};
