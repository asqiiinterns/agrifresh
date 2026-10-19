// Web only: renders the document HTML and downloads it as a real PDF file.
export async function downloadPdf(html: string, fileName: string): Promise<void> {
  const { default: html2pdf } = await import("html2pdf.js");
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.width = "800px";
  // Keep the document's own styles: <style> blocks work inside a regular element.
  container.innerHTML = html.replace(/<!doctype[^>]*>/i, "").replace(/<\/?(html|head|body)[^>]*>/gi, "");
  document.body.appendChild(container);
  try {
    await html2pdf()
      .set({
        margin: [8, 8, 8, 8],
        filename: `${fileName.replace(/[^\w-]+/g, "-")}.pdf`,
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"], before: ".sheet + .sheet" },
      })
      .from(container)
      .save();
  } finally {
    container.remove();
  }
}
