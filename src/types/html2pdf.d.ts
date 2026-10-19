declare module "html2pdf.js" {
  type Worker = {
    set(options: Record<string, unknown>): Worker;
    from(element: HTMLElement | string): Worker;
    save(): Promise<void>;
  };
  export default function html2pdf(): Worker;
}
