export class DockpackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DockpackError";
  }
}
