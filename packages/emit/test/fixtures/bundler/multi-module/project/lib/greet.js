import config from "../data/config.js";

export const greet = (name) => `${config.greeting}, ${name}!`;
export default greet;
