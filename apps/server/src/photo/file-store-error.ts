export class PhotoFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PhotoFileError";
    this.code = code;
  }
}
