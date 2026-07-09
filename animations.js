// ----- Scroll, entrance & hover animations (Motion, vanilla) -----
// Motion (motion.dev) is the framework-free sibling of framer-motion,
// loaded over an ESM CDN so it needs no bundler or React.
//
// Elements start hidden via the `.anim` CSS rules (added by a blocking
// <head> script, so there's no flash). If this module or the CDN fails,
// reveal() strips `.anim` and the page shows normally — progressive enhancement.

const root = document.documentElement;
const reveal = () => root.classList.remove("anim");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Pieces we hide-then-animate. Kept in sync with the `.anim` rules in styles.css.
const CONTENT = [
  ".section__title",
  ".section__text",
  ".about__image",
  ".progress-container",
  ".card",
  ".milestone",
  ".contact__panel",
  ".form",
].join(", ");

// Blocks that "pop" (scale) when hovered. The form is excluded so it doesn't
// scale while you're typing in it — it still gets a hover glow via CSS.
const HOVER = ".card, .about__image, .contact__panel";

if (reduceMotion) {
  reveal();
} else {
  (async () => {
    try {
      const { animate, inView, stagger } = await import(
        "https://cdn.jsdelivr.net/npm/motion@11.11.17/+esm"
      );

      const spring = { type: "spring", stiffness: 220, damping: 20 };
      const popSpring = { type: "spring", stiffness: 320, damping: 18 };

      // Reveal a container's pieces on enter, reset on leave so it REPLAYS
      // every time the container scrolls into view (from above or below).
      const bindReveal = (container, selector, hooks) => {
        const bits = container.querySelectorAll(selector);
        inView(
          container,
          () => {
            if (bits.length) {
              animate(bits, { opacity: [0, 1], y: [36, 0] }, { ...spring, delay: stagger(0.09) });
            }
            hooks?.enter?.();
            // Returned callback runs when the container leaves the viewport.
            return () => {
              if (bits.length) animate(bits, { opacity: 0, y: 36 }, { duration: 0 });
              hooks?.leave?.();
            };
          },
          { amount: 0.2 }
        );
      };

      // Hero — replays when you scroll back to the top.
      const hero = document.querySelector(".hero");
      if (hero) bindReveal(hero, ".hero__title, .hero__lead, .hero__cta");

      // Content sections.
      document.querySelectorAll("main .section").forEach((section) => {
        const fill = section.querySelector(".progress-fill");
        const target = fill ? fill.style.width || "80%" : null;

        bindReveal(section, CONTENT, fill && {
          enter: () =>
            animate(fill, { width: ["0%", target] }, { duration: 1.2, delay: 0.2, easing: [0.22, 1, 0.36, 1] }),
          leave: () => animate(fill, { width: "0%" }, { duration: 0 }),
        });
      });

      // Hover pop-out. `scale` composes with the entrance `y`, so they don't fight.
      document.querySelectorAll(HOVER).forEach((el) => {
        el.addEventListener("pointerenter", () => animate(el, { scale: 1.04 }, popSpring));
        el.addEventListener("pointerleave", () => animate(el, { scale: 1 }, popSpring));
      });
    } catch (err) {
      // CDN/library failure: show everything, unanimated.
      reveal();
      console.warn("Motion failed to load; showing content without animation.", err);
    }
  })();
}
