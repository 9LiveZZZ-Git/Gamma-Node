/* =========================================================================
 * Mobile palette toggle
 * ======================================================================== */
document.getElementById("mobile-pal-btn").addEventListener("click", () => {
  document.querySelector(".palette").classList.toggle("open");
});
// Close palette when tapping a node from it on mobile
document.querySelector(".palette").addEventListener("click", e => {
  if (window.innerWidth <= 720 && e.target.closest(".pal-item")) {
    document.querySelector(".palette").classList.remove("open");
  }
});

