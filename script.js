// ----- Subtle scroll reveal (clean + readable) -----
const revealEls = document.querySelectorAll(".reveal");

const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) entry.target.classList.add("is-visible");
    }
  },
  { threshold: 0.12 }
);

revealEls.forEach((el) => io.observe(el));

// ----- Year in footer -----
document.getElementById("year").textContent = new Date().getFullYear();
