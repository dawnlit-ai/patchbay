import type { JSX } from 'react';
import type { JsonSchema } from '@shared/flow';
import { fieldsOf, isObject, kindLabel, requiredOf } from '../schemaShape';

/** A named schema read as a list of the fields a step fills, for looking at rather than editing. */

export function SchemaFields({schema}: { schema: JsonSchema }): JSX.Element {
    const fields = Object.entries(fieldsOf(schema));
    if (fields.length === 0) {
        return (
            <div className="schema-fields empty-fields">
                {isObject(schema.properties) || schema.type === 'object'
                    ? 'No fields yet.'
                    : `Not a group of fields: it is ${kindLabel(schema).toLowerCase()}.`}
            </div>
        );
    }
    const required = new Set(requiredOf(schema));
    return (
        <div className="schema-fields">
            {fields.map(([name, field]) => (
                <div key={name} className="schema-field">
                    <code className="name">{name}</code>
                    <span className="type">
                        {kindLabel(field)}
                        {!required.has(name) && <span className="optional"> · optional</span>}
                    </span>
                    <span className="desc">
                        {isObject(field) && typeof field.description === 'string' ? field.description : ''}
                    </span>
                </div>
            ))}
        </div>
    );
}
