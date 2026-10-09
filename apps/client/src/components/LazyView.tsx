import type { ComponentType, FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * A screen loaded on first use, so code most people never open (the admin area, the mesh screen, the
 * privacy policy) stays out of the main bundle. The service worker precaches every chunk a build
 * emits, so an offline client still opens these. Renders nothing for the moment the chunk takes to
 * arrive; a failed load is thrown to the top-level `ErrorBoundary`, which offers a way back and a
 * reload.
 */
export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>): FunctionComponent<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;

  /** Starts the load once per page; a failed load may be retried by the next mount. */
  function start(): Promise<ComponentType<P>> {
    pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  }

  function LazyView(props: P) {
    const [component, setComponent] = useState<ComponentType<P> | undefined>(() => loaded);
    const [error, setError] = useState<unknown>();

    useEffect(() => {
      if (component) {
        return;
      }
      let live = true;
      start().then(
        (next) => live && setComponent(() => next),
        (failure: unknown) => live && setError(failure ?? new Error("Could not load this screen")),
      );
      return () => {
        live = false;
      };
    }, [component]);

    if (error !== undefined) {
      throw error;
    }
    const Component = component;
    return Component ? <Component {...props} /> : null;
  }

  return LazyView;
}
