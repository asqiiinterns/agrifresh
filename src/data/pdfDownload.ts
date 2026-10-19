// Native builds share the PDF instead (see sharePdf); the web build uses pdfDownload.web.ts.
export async function downloadPdf(_html: string, _fileName: string): Promise<void> {
  throw new Error("Le téléchargement direct n’est disponible que sur le web : utilisez « Partager ».");
}
