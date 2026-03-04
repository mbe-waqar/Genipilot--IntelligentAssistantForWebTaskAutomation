function replaceLogo() {
    const img = document.querySelector('#pretty-loading-animation img');
    if (img) {
        img.src = "./whitelogo.png";
        img.alt = "My Logo";

        img.style.width = "200px";
        img.style.height = "auto";
        img.style.position = "absolute";
        img.style.left = "50%";
        img.style.top = "50%";
        img.style.transform = "translate(-50%, -50%)";
        img.style.opacity = "0.9";
    }
}

// Run once in case it's already there
replaceLogo();

// Watch the page for the loader being added dynamically
const observer = new MutationObserver(() => replaceLogo());
observer.observe(document.documentElement, { childList: true, subtree: true });
