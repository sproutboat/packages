export class Counter {
  value = 0;
  next() {
    this.value += 1;
    return this;
  }
}
