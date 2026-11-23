const refValue = Symbol('journey reference value');
const buildJourney = Symbol('build journey');

/** A value bound when a journey runs. The type follows the input or the declared output. */
export type Ref<T> = JourneyRef<T>;

class JourneyRef<T> {
  declare readonly [refValue]: T;

  constructor(readonly expression: string, readonly owner: symbol) {}
}

type Scalar = string | number | boolean | null;
type Literal = Scalar | readonly Literal[] | { readonly [key: string]: Literal };
type Value = Scalar | Ref<unknown> | readonly Value[] | { readonly [key: string]: Value };
type Binding<T> = unknown extends T ? Value : Ref<T> | (
  T extends object ? { readonly [K in keyof T]: Binding<T[K]> } : T
);

type InputSchema = { readonly type: 'object'; readonly properties: Readonly<Record<string, unknown>> }
  & Readonly<Record<string, unknown>>;
type JsonType = { string: string; number: number; integer: number; boolean: boolean; null: null };
type InputType<S> = S extends { readonly type: infer T }
  ? T extends keyof JsonType ? JsonType[T]
  : T extends 'array' ? S extends { readonly items: infer I } ? InputType<I>[] : unknown[]
  : T extends 'object' ? Record<string, unknown> : unknown
  : unknown;

type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';
type JourneyRequest = Partial<Record<ParameterLocation | 'body', unknown>>;
type OpenRequest = Record<ParameterLocation, Record<string, unknown>> & { body: unknown };

type WriteFields = Readonly<Record<string, Value>>;
type WriteTarget =
  | { table: string; key?: WriteFields }
  | { collection: string; key?: WriteFields }
  | { key: string | Ref<string> };

export type ExpectedWrite = WriteTarget & {
  /** Use the system ID advertised in capabilities, such as sqlite, mongodb or redis. */
  store: string;
  op: string;
  values?: WriteFields;
};

export type ExpectedEffect = { kind: string; readonly [field: string]: Value };
type StepExpectations = {
  persona?: string;
  writes?: readonly ExpectedWrite[];
  effects?: readonly ExpectedEffect[];
  unlisted?: 'fail' | 'warn' | 'ignore';
};

export interface ApprovedDifference {
  id: string;
  step: string;
  target: { store: string; field?: string } & ({ table: string } | { collection: string } | { key: string });
  kind: 'value' | 'missing' | 'extra';
  expected?: Literal;
  actual?: Literal;
  reason: string;
  approvedBy: string;
  approvedOn: string;
  expires?: string;
  link?: string;
}

type MatchType = 'any' | 'date-time' | 'uuid' | 'string' | 'number' | 'integer' | 'boolean';

export const match = {
  any: (type: MatchType = 'any') => ({ type }),
  pattern: (pattern: string) => ({ pattern }),
  changed: (from: Value, to: Value) => ({ from, to }),
};

export interface JourneyOptions<S extends InputSchema = InputSchema> {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  group?: string;
  runAs?: string;
  /** The reason this journey requires Send. Redis write expectations also imply Send. */
  sendOnly?: string;
  definedIn?: { type: string; file?: string };
  inputs?: S;
}

type Step = {
  stepId: string;
  operationId: string;
  parameters?: { in: ParameterLocation; name: string; value: unknown }[];
  requestBody?: { contentType: string; payload: unknown };
  successCriteria?: { condition: string }[];
  outputs?: Record<string, string>;
};

export class JourneyStep<R extends JourneyRequest> {
  /** @internal Created by the journey builder. */
  constructor(
    private readonly step: Step,
    private readonly expectations: StepExpectations,
    private readonly owner: symbol,
    private readonly problems: string[],
  ) {}

  set<L extends ParameterLocation, K extends keyof NonNullable<R[L]> & string>(
    location: L, name: K, value: Binding<NonNullable<R[L]>[K]>,
  ): this {
    (this.step.parameters ??= []).push({ in: location, name, value });
    return this;
  }

  body(payload: Binding<R['body']>, contentType = 'application/json'): this {
    this.step.requestBody = { contentType, payload };
    return this;
  }

  succeedsWith(status: number): this {
    return this.succeedsWhen(`$statusCode == ${status}`);
  }

  succeedsWhen(condition: string): this {
    (this.step.successCriteria ??= []).push({ condition });
    return this;
  }

  /** Declare the response expression and, for typed consumers, its resolved type. */
  output<T = unknown>(name: string, expression: string): Ref<T> {
    const outputs: NonNullable<Step['outputs']> = this.step.outputs ??= Object.create(null);
    if (!referenceName.test(name) || Object.hasOwn(outputs, name)) {
      this.problems.push(`Step "${this.step.stepId}": invalid or duplicate output "${name}".`);
    }
    outputs[name] = expression;
    return new JourneyRef<T>(`$steps.${this.step.stepId}.outputs.${name}`, this.owner);
  }

  runAs(persona: string): this {
    this.expectations.persona = persona;
    return this;
  }

  /** Use an empty writes array to assert that a step writes nothing. */
  expectWrites(expectations: Omit<StepExpectations, 'persona'>): this {
    Object.assign(this.expectations, { writes: [], unlisted: 'fail', ...expectations });
    return this;
  }
}

export interface JourneyBuilder<S extends InputSchema> {
  input<K extends keyof S['properties'] & string>(name: K): Ref<InputType<S['properties'][K]>>;
  step<R extends JourneyRequest = OpenRequest>(stepId: string, operationId: string): JourneyStep<R>;
  output(name: string, value: Ref<unknown>): void;
  approveDifference(record: ApprovedDifference): void;
}

const referenceName = /^[A-Za-z0-9_-]+$/;
const inputReference = /^\$inputs\.([\w-]+)(?:\.[\w-]+)*$/;
const stepReference = /^\$steps\.([\w-]+)\.outputs\.([\w-]+)(?:\.[\w-]+)*$/;

interface CompiledJourney {
  workflow: { workflowId: string };
  expectations: unknown;
  differences: (ApprovedDifference & { journey: string })[];
  problems: string[];
}

export interface CodeJourney {
  readonly id: string;
  readonly [buildJourney]: (operationIds: ReadonlySet<string>) => CompiledJourney;
}

/** Define a workflow once. The adapter evaluates its definition during startup. */
export function defineJourney<const S extends InputSchema = { type: 'object'; properties: Record<never, never> }>(
  options: JourneyOptions<S>, define: (journey: JourneyBuilder<S>) => void,
): CodeJourney {
  return {
    id: options.id,
    [buildJourney](operationIds) {
      const { id, name, summary = name, description, inputs, group, runAs, definedIn } = options;
      const owner = Symbol(id);
      const problems: string[] = [];
      const steps = new Map<string, { step: Step; expectations: StepExpectations }>();
      const outputs = new Map<string, Ref<unknown>>();
      const differences: CompiledJourney['differences'] = [];
      const properties = inputs?.properties ?? {};
      const knownInput = (key: string) => Object.hasOwn(properties, key);

      define({
        input(key) {
          if (!referenceName.test(key) || !knownInput(key)) problems.push(`Unknown input "${key}".`);
          return new JourneyRef(`$inputs.${key}`, owner);
        },
        step(stepId, operationId) {
          if (!referenceName.test(stepId) || steps.has(stepId)) problems.push(`Invalid or duplicate step "${stepId}".`);
          if (!operationIds.has(operationId)) {
            problems.push(`Step "${stepId}": unknown operationId "${operationId}" in the served OpenAPI document.`);
          }
          const step = { stepId, operationId };
          const expectations = {};
          steps.set(stepId, { step, expectations });
          return new JourneyStep(step, expectations, owner, problems);
        },
        output(key, value) {
          if (!referenceName.test(key) || outputs.has(key)) problems.push(`Invalid or duplicate workflow output "${key}".`);
          outputs.set(key, value);
        },
        approveDifference(record) {
          differences.push({ ...record, journey: id });
        },
      });
      if (!id.trim() || !name.trim() || !steps.size) problems.push('A journey needs an ID, a name and at least one step.');

      // Keep references as Arazzo expressions in JSON. Request bindings only see earlier outputs;
      // expectations can see the current output because they are checked after the response.
      const available = new Map<string, Step['outputs']>();
      function encode(value: unknown, location: string): unknown {
        return JSON.parse(JSON.stringify(value, (_key, current: unknown) => {
          if (current instanceof JourneyRef) {
            if (current.owner !== owner) problems.push(`${location}: reference belongs to another journey.`);
            current = current.expression;
          }
          if (typeof current === 'string') {
            const expressions = current.startsWith('$inputs.') || current.startsWith('$steps.') ? [current]
              : [...current.matchAll(/\{(\$(?:inputs|steps)\.[^{}]+)\}/g)].map(([, expression]) => expression);
            for (const expression of expressions) {
              const input = inputReference.exec(expression);
              const step = stepReference.exec(expression);
              if (input ? !knownInput(input[1]) : !step || !Object.hasOwn(available.get(step[1]) ?? {}, step[2])) {
                problems.push(`${location}: unresolved input or step output "${expression}".`);
              }
            }
          }
          return current;
        }));
      }

      const stepEntries = new Map<string, unknown>();
      const workflowSteps = [];
      let sendOnly = options.sendOnly;
      for (const { step, expectations } of steps.values()) {
        const location = `Step "${step.stepId}"`;
        workflowSteps.push(encode(step, location));
        available.set(step.stepId, step.outputs);
        if (Object.keys(expectations).length) stepEntries.set(step.stepId, encode(expectations, location));
        if (expectations.writes?.some(write => write.store === 'redis')) {
          sendOnly ??= `${location} writes to Redis, which cannot roll back.`;
        }
      }
      const workflow = {
        workflowId: id, summary, description, inputs, steps: workflowSteps,
        ...(outputs.size ? { outputs: encode(Object.fromEntries(outputs), 'Workflow outputs') } : {}),
      };
      const expectations = {
        group, runAs, definedIn,
        ...(sendOnly !== undefined ? { sendOnly: true, sendOnlyReason: sendOnly } : {}),
      };
      const approvals = new Set<string>();
      for (const record of differences) {
        if (!steps.has(record.step)) problems.push(`Approved difference "${record.id}": unknown step "${record.step}".`);
        if (!record.id.trim() || !record.reason.trim() || !record.approvedBy.trim() || approvals.has(record.id)) {
          problems.push(`Approved difference "${record.id}" needs a unique ID, a reason and an approver.`);
        }
        approvals.add(record.id);
      }
      return {
        workflow, differences, problems: [...new Set(problems)],
        expectations: { ...expectations, steps: Object.fromEntries(stepEntries) },
      };
    },
  };
}

export function compileJourney(journey: CodeJourney, operationIds: ReadonlySet<string>) {
  return journey[buildJourney](operationIds);
}
