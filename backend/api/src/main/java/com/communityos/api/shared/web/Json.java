package com.communityos.api.shared.web;

import com.communityos.api.shared.domain.Ids;
import com.communityos.api.shared.domain.Money;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import java.io.IOException;
import java.math.BigDecimal;

/**
 * The one JSON configuration for requests, responses, the outbox and stored idempotent replies.
 *  - an unknown or misspelt property in a request is an error (400), so a field the client is not allowed to set (createdBy, status, amount on
 *    a payment order ...) can never be slipped in: request DTOs simply do not have it
 *  - money travels as a decimal STRING ("3540.00"), never a binary float
 *  - no polymorphic type info is ever read from input
 */
public final class Json {
    private Json() {}

    public static ObjectMapper mapper() {
        SimpleModule money = new SimpleModule("money");
        money.addSerializer(Money.class, new JsonSerializer<>() {
            @Override public void serialize(Money v, JsonGenerator g, SerializerProvider p) throws IOException { g.writeString(v.amount().toPlainString()); }
        });
        money.addDeserializer(Money.class, new JsonDeserializer<>() {
            @Override public Money deserialize(JsonParser p, DeserializationContext c) throws IOException {
                if (p.currentToken() != JsonToken.VALUE_STRING && p.currentToken() != JsonToken.VALUE_NUMBER_INT && p.currentToken() != JsonToken.VALUE_NUMBER_FLOAT)
                    return (Money) c.handleUnexpectedToken(Money.class, p);
                String s = p.getText().trim();
                if (!s.matches("-?[0-9]{1,12}(\\.[0-9]{1,2})?")) throw c.weirdStringException(s, Money.class, "money: up to 12 digits and 2 decimals");
                return new Money(new BigDecimal(s));
            }
        });
        // a decimal may come as a number or as a plain decimal string ("1180.00" - how the apps send amounts); nothing else is coerced
        money.addDeserializer(BigDecimal.class, new JsonDeserializer<>() {
            @Override public BigDecimal deserialize(JsonParser p, DeserializationContext c) throws IOException {
                if (p.currentToken() == JsonToken.VALUE_NUMBER_INT || p.currentToken() == JsonToken.VALUE_NUMBER_FLOAT) return p.getDecimalValue();
                if (p.currentToken() != JsonToken.VALUE_STRING) return (BigDecimal) c.handleUnexpectedToken(BigDecimal.class, p);
                String s = p.getText().trim();
                if (s.isEmpty()) return null;
                if (!s.matches("-?[0-9]{1,15}(\\.[0-9]{1,6})?")) throw c.weirdStringException(s, BigDecimal.class, "a decimal number");
                return new BigDecimal(s);
            }
        });
        for (Class<?> id : Ids.class.getDeclaredClasses()) money.addSerializer(id, ToStringSerializer.instance);   // ids travel as plain strings
        return JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .enable(DeserializationFeature.FAIL_ON_NUMBERS_FOR_ENUMS)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(SerializationFeature.FAIL_ON_EMPTY_BEANS)
            .addModule(money)
            .findAndAddModules()
            .build();
    }
}
