// Available in every supported runtime (browsers, Node >= 17); declared here so the
// engine stays free of DOM and Node type dependencies.
declare function structuredClone<T>(value: T): T;
