// The two writes end to end: POST and DELETE /v1/predictions and POST
// /v1/registrations. Ports of apps/data-api/src/__tests__/predictions.test.ts
// and registrations.test.ts, case for case.

mod common;

use common::*;
use data_api_rs::key::hash_key;
use data_api_rs::predictions::MAX_BODY_BYTES;
use hyper::Method;
use serde_json::{Value, json};

const OTHER_KEY_ID: &str = "77777777-2222-3333-4444-555555555555";

fn r(c: char) -> String {
    c.to_string().repeat(64)
}

fn prediction(over: Value) -> Value {
    let mut base = json!({
        "format": "singles",
        "side_a": [r('a')],
        "side_b": [r('b')],
        "probability": 0.64,
        "model": "elo-v3",
        "made_at": "2027-01-15T08:00:00Z",
    });
    let fields = base.as_object_mut().unwrap();
    for (k, v) in over.as_object().unwrap() {
        if v.is_null() {
            fields.remove(k);
        } else {
            fields.insert(k.clone(), v.clone());
        }
    }
    base
}

fn p() -> Value {
    prediction(json!({}))
}

fn rpc_calls(h: &Harness) -> Vec<Call> {
    h.calls()
        .into_iter()
        .filter(|c| c.fn_name != "data_api_verify_key")
        .collect()
}

const JSON: &[(&str, &str)] = &[("content-type", "application/json")];

async fn predictions_harness() -> (Harness, String) {
    let h = start().await;
    // The harness clock starts at 2027-01-15T08:00:00Z, so made_at above is now.
    assert_eq!(
        data_api_rs::time::to_iso(1_800_000_000_000).as_deref(),
        Some("2027-01-15T08:00:00.000Z")
    );
    let key = new_key();
    h.grant(&key, &["predictions:write"]);
    h.set_rpc("data_api_write_predictions", |body| {
        let n = body["p_predictions"].as_array().map_or(0, Vec::len);
        Value::Array(
            (0..n)
                .map(|i| json!({"item": i, "status": "created", "reason": null}))
                .collect(),
        )
    });
    h.set_rpc("data_api_delete_predictions", |body| {
        let n = body["p_matchups"].as_array().map_or(0, Vec::len);
        Value::Array(
            (0..n)
                .map(|i| json!({"item": i, "status": "deleted", "reason": null}))
                .collect(),
        )
    });
    (h, key)
}

async fn write(h: &Harness, key: Option<&str>, body: &Value) -> Res {
    h.send(Method::POST, "/v1/predictions", key, JSON, body.to_string())
        .await
}

// POST /v1/predictions: before the body

#[tokio::test]
async fn predictions_401_without_a_key() {
    let (h, _) = predictions_harness().await;
    let res = write(&h, None, &json!({"predictions": [p()]})).await;
    assert_eq!(res.status, 401);
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn predictions_403_a_key_without_the_scope_and_never_call_the_write() {
    let (h, _) = predictions_harness().await;
    let reader = new_key();
    h.grant_as(
        &reader,
        &["players:read", "matches:read"],
        OTHER_KEY_ID,
        CONSUMER,
    );
    let res = write(&h, Some(&reader), &json!({"predictions": [p()]})).await;
    assert_eq!(res.status, 403);
    assert_eq!(
        res.json(),
        json!({"error": "forbidden", "detail": "this key does not carry predictions:write"})
    );
    assert!(rpc_calls(&h).is_empty());
}

#[tokio::test]
async fn predictions_405_a_get_before_auth_naming_the_two_methods() {
    let (h, key) = predictions_harness().await;
    let res = h.get("/v1/predictions", Some(&key)).await;
    assert_eq!(res.status, 405);
    assert_eq!(res.header("allow"), Some("POST, DELETE"));
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn a_write_method_on_a_read_route_405s_naming_get() {
    let (h, key) = predictions_harness().await;
    let res = h
        .request(Method::DELETE, "/v1/players", Some(&key), &[])
        .await;
    assert_eq!(res.status, 405);
    assert_eq!(res.header("allow"), Some("GET"));
}

#[tokio::test]
async fn predictions_415_a_body_not_declared_json() {
    let (h, key) = predictions_harness().await;
    let body = json!({"predictions": [p()]}).to_string();
    let res = h
        .send(
            Method::POST,
            "/v1/predictions",
            Some(&key),
            &[("content-type", "text/plain")],
            body.clone(),
        )
        .await;
    assert_eq!(res.status, 415);
    assert_eq!(res.json(), json!({"error": "unsupported_media_type"}));
    // No Content-Type at all is the same answer.
    let res = h
        .send(Method::POST, "/v1/predictions", Some(&key), &[], body)
        .await;
    assert_eq!(res.status, 415);
    assert!(rpc_calls(&h).is_empty());
}

#[tokio::test]
async fn predictions_accept_a_charset_and_any_case_on_the_content_type() {
    let (h, key) = predictions_harness().await;
    for declared in ["application/json; charset=utf-8", " Application/JSON ;x=1"] {
        let res = h
            .send(
                Method::POST,
                "/v1/predictions",
                Some(&key),
                &[("content-type", declared)],
                json!({"predictions": [p()]}).to_string(),
            )
            .await;
        assert_eq!(res.status, 200, "{declared}");
    }
}

#[tokio::test]
async fn predictions_413_a_body_over_the_cap() {
    let (h, key) = predictions_harness().await;
    let body = json!({"pad": "x".repeat(MAX_BODY_BYTES)}).to_string();
    let res = h
        .send(Method::POST, "/v1/predictions", Some(&key), JSON, body)
        .await;
    assert_eq!(res.status, 413);
    assert_eq!(res.json(), json!({"error": "payload_too_large"}));
    assert!(rpc_calls(&h).is_empty());
}

#[tokio::test]
async fn predictions_take_a_body_of_exactly_the_cap() {
    let (h, key) = predictions_harness().await;
    // Valid JSON padded with spaces to the byte: read, parsed, then refused
    // for its shape, never for its size.
    let mut body = json!({"predictions": [p()], "pad": 1}).to_string();
    body.push_str(&" ".repeat(MAX_BODY_BYTES - body.len()));
    assert_eq!(body.len(), MAX_BODY_BYTES);
    let res = h
        .send(Method::POST, "/v1/predictions", Some(&key), JSON, body)
        .await;
    assert_eq!(res.status, 400);
    assert_eq!(res.json(), json!({"error": "bad_request", "field": "pad"}));
}

#[tokio::test]
async fn predictions_400_a_body_that_is_not_json() {
    let (h, key) = predictions_harness().await;
    for body in ["{\"predictions\": [", "", "\u{feff}{}", "[1,]"] {
        let res = h
            .send(Method::POST, "/v1/predictions", Some(&key), JSON, body)
            .await;
        assert_eq!(res.status, 400, "{body:?}");
        assert_eq!(res.json(), json!({"error": "bad_request", "field": "body"}));
    }
}

#[tokio::test]
async fn predictions_400_a_deeply_nested_body_without_falling_over() {
    let (h, key) = predictions_harness().await;
    let depth = 30_000;
    let body = format!(
        "{{\"predictions\":{}{}}}",
        "[".repeat(depth),
        "]".repeat(depth)
    );
    let res = h
        .send(Method::POST, "/v1/predictions", Some(&key), JSON, body)
        .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({"error": "bad_request", "field": "predictions[0]"})
    );
}

// POST /v1/predictions: the shape

#[tokio::test]
async fn predictions_400_a_bad_shape_naming_the_field_without_the_database() {
    let (h, key) = predictions_harness().await;
    let hundred_and_one: Vec<Value> = (0..101).map(|_| p()).collect();
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "a missing field",
            json!({"predictions": [prediction(json!({"model": null}))]}),
            "predictions[0].model",
        ),
        (
            "an extra field",
            json!({"predictions": [prediction(json!({"confidence": 0.9}))]}),
            "predictions[0].confidence",
        ),
        (
            "an extra top-level key",
            json!({"predictions": [p()], "dry_run": true}),
            "dry_run",
        ),
        ("an empty batch", json!({"predictions": []}), "predictions"),
        (
            "a batch over 100",
            json!({"predictions": hundred_and_one}),
            "predictions",
        ),
        (
            "an unknown format",
            json!({"predictions": [prediction(json!({"format": "mixed"}))]}),
            "predictions[0].format",
        ),
        (
            "singles with two refs a side",
            json!({"predictions": [prediction(json!({"side_a": [r('a'), r('c')]}))]}),
            "predictions[0].side_a",
        ),
        (
            "doubles with one ref a side",
            json!({"predictions": [prediction(json!({"format": "doubles"}))]}),
            "predictions[0].side_a",
        ),
        (
            "a malformed ref",
            json!({"predictions": [prediction(json!({"side_b": [r('B')]}))]}),
            "predictions[0].side_b",
        ),
        (
            "the same ref on both sides",
            json!({"predictions": [prediction(json!({"side_b": [r('a')]}))]}),
            "predictions[0].side_b",
        ),
        (
            "a probability over 1",
            json!({"predictions": [prediction(json!({"probability": 1.2}))]}),
            "predictions[0].probability",
        ),
        (
            "a probability as a string",
            json!({"predictions": [prediction(json!({"probability": "0.5"}))]}),
            "predictions[0].probability",
        ),
        (
            "a model with a newline",
            json!({"predictions": [prediction(json!({"model": "elo\nv3"}))]}),
            "predictions[0].model",
        ),
        (
            "a made_at with an offset",
            json!({"predictions": [prediction(json!({"made_at": "2027-01-15T08:00:00+00:00"}))]}),
            "predictions[0].made_at",
        ),
        (
            "a made_at in the future",
            json!({"predictions": [prediction(json!({"made_at": "2027-01-15T09:00:00Z"}))]}),
            "predictions[0].made_at",
        ),
        (
            "a bare item with a bad field",
            prediction(json!({"probability": -0.1})),
            "probability",
        ),
    ];
    for (label, body, field) in cases {
        let res = write(&h, Some(&key), &body).await;
        assert_eq!(res.status, 400, "{label}");
        assert_eq!(
            res.json(),
            json!({"error": "bad_request", "field": field}),
            "{label}"
        );
    }
    assert!(rpc_calls(&h).is_empty());
}

// POST /v1/predictions: the write

#[tokio::test]
async fn predictions_send_the_key_hash_and_the_items_and_answer_200_with_the_counts() {
    let (h, key) = predictions_harness().await;
    let doubles = prediction(json!({
        "format": "doubles",
        "side_a": [r('a'), r('b')],
        "side_b": [r('c'), r('d')],
    }));
    let res = write(&h, Some(&key), &json!({"predictions": [p(), doubles]})).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        res.text(),
        json!({
            "results": [{"index": 0, "status": "created"}, {"index": 1, "status": "created"}],
            "created": 2, "replaced": 0, "refused": 0,
        })
        .to_string()
    );
    assert_eq!(res.header("cache-control"), Some("no-store"));
    let calls = rpc_calls(&h);
    assert_eq!(calls[0].fn_name, "data_api_write_predictions");
    assert_eq!(
        calls[0].body,
        json!({"p_key_hash": hash_key(&key), "p_predictions": [p(), doubles]})
    );
}

#[tokio::test]
async fn predictions_take_one_bare_prediction_as_a_batch_of_one() {
    let (h, key) = predictions_harness().await;
    let res = write(&h, Some(&key), &p()).await;
    assert_eq!(res.status, 200);
    assert_eq!(rpc_calls(&h)[0].body["p_predictions"], json!([p()]));
}

#[tokio::test]
async fn predictions_are_never_cached() {
    let (h, key) = predictions_harness().await;
    write(&h, Some(&key), &json!({"predictions": [p()]})).await;
    write(&h, Some(&key), &json!({"predictions": [p()]})).await;
    let fns: Vec<String> = rpc_calls(&h).into_iter().map(|c| c.fn_name).collect();
    assert_eq!(
        fns,
        ["data_api_write_predictions", "data_api_write_predictions"]
    );
}

#[tokio::test]
async fn predictions_422_when_any_item_is_refused_with_the_same_body() {
    let (h, key) = predictions_harness().await;
    h.set_rpc("data_api_write_predictions", |_| {
        json!([
            {"item": 0, "status": "replaced", "reason": null},
            {"item": 1, "status": "refused", "reason": "player"},
        ])
    });
    let body = json!({"predictions": [p(), prediction(json!({"side_b": [r('c')]}))]});
    let res = write(&h, Some(&key), &body).await;
    assert_eq!(res.status, 422);
    assert_eq!(
        res.json(),
        json!({
            "results": [
                {"index": 0, "status": "replaced"},
                {"index": 1, "status": "refused", "reason": "player"},
            ],
            "created": 0, "replaced": 1, "refused": 1,
        })
    );
}

#[tokio::test]
async fn predictions_401_when_the_database_no_longer_accepts_the_key() {
    let (h, key) = predictions_harness().await;
    h.set_rpc(
        "data_api_write_predictions",
        |_| json!([{"item": 0, "status": "refused", "reason": "key"}]),
    );
    let res = write(&h, Some(&key), &json!({"predictions": [p()]})).await;
    assert_eq!(res.status, 401);
    assert_eq!(res.header("www-authenticate"), Some("Bearer"));
}

#[tokio::test]
async fn predictions_503_an_upstream_failure() {
    let (h, key) = predictions_harness().await;
    h.fail_fn(Some(("data_api_write_predictions", 500)));
    let res = write(&h, Some(&key), &json!({"predictions": [p()]})).await;
    assert_eq!(res.status, 503);
    assert_eq!(res.json(), json!({"error": "unavailable"}));
}

#[tokio::test]
async fn predictions_charge_a_whole_batch_to_the_rate_budget_once() {
    let (h, key) = predictions_harness().await;
    let batch: Vec<Value> = (0..100).map(|_| p()).collect();
    for _ in 0..60 {
        let res = write(&h, Some(&key), &json!({"predictions": batch})).await;
        assert_eq!(res.status, 200);
    }
    let res = write(&h, Some(&key), &json!({"predictions": [p()]})).await;
    assert_eq!(res.status, 429);
}

// DELETE /v1/predictions

#[tokio::test]
async fn delete_by_matchup_reports_each_item() {
    let (h, key) = predictions_harness().await;
    h.set_rpc("data_api_delete_predictions", |_| {
        json!([
            {"item": 0, "status": "deleted", "reason": null},
            {"item": 1, "status": "not_found", "reason": null},
        ])
    });
    let matchups = json!([
        {"format": "singles", "side_a": [r('b')], "side_b": [r('a')]},
        {"format": "doubles", "side_a": [r('a'), r('b')], "side_b": [r('c'), r('d')]},
    ]);
    let res = h
        .send(
            Method::DELETE,
            "/v1/predictions",
            Some(&key),
            JSON,
            json!({"matchups": matchups}).to_string(),
        )
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(
        res.text(),
        json!({
            "results": [{"index": 0, "status": "deleted"}, {"index": 1, "status": "not_found"}],
            "deleted": 1, "not_found": 1, "refused": 0,
        })
        .to_string()
    );
    let calls = rpc_calls(&h);
    assert_eq!(calls[0].fn_name, "data_api_delete_predictions");
    assert_eq!(
        calls[0].body,
        json!({"p_key_hash": hash_key(&key), "p_matchups": matchups})
    );
}

#[tokio::test]
async fn delete_400s_a_matchup_carrying_a_probability() {
    let (h, key) = predictions_harness().await;
    let res = h
        .send(
            Method::DELETE,
            "/v1/predictions",
            Some(&key),
            JSON,
            json!({"matchups": [p()]}).to_string(),
        )
        .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({"error": "bad_request", "field": "matchups[0].probability"})
    );
}

#[tokio::test]
async fn delete_403s_without_the_scope() {
    let (h, _) = predictions_harness().await;
    let reader = new_key();
    h.grant_as(&reader, &["players:read"], OTHER_KEY_ID, CONSUMER);
    let res = h
        .send(
            Method::DELETE,
            "/v1/predictions",
            Some(&reader),
            JSON,
            json!({"matchups": []}).to_string(),
        )
        .await;
    assert_eq!(res.status, 403);
}

#[tokio::test]
async fn predictions_log_the_template_never_the_body_or_a_ref() {
    let (h, key) = predictions_harness().await;
    write(&h, Some(&key), &json!({"predictions": [p()]})).await;
    write(
        &h,
        Some(&key),
        &json!({"predictions": [prediction(json!({"probability": 2}))]}),
    )
    .await;
    let all = h.log_text();
    assert!(all.contains("\"path\":\"/v1/predictions\""));
    assert!(!all.contains(&r('a')));
    assert!(!all.contains("elo-v3"));
    assert!(!all.contains(&key));
}

// POST /v1/registrations

const EVENT_A: &str = "aaaaaaaa-1111-4222-8333-444444444444";
const EVENT_B: &str = "bbbbbbbb-1111-4222-8333-444444444444";

fn response(over: Value) -> Value {
    let mut base = json!({
        "form_id": "1FAIpQLSexampleForm",
        "response_id": "ACYDBNj-example",
        "submitted_at": "2026-10-08T10:00:00Z",
        "email": "Guest.Person@Example.org ",
        "name": "  Guest   Person ",
        "entries": [{"event_id": EVENT_A, "partner_name": "Second Guest"}],
    });
    let fields = base.as_object_mut().unwrap();
    for (k, v) in over.as_object().unwrap() {
        fields.insert(k.clone(), v.clone());
    }
    base
}

async fn registrations_harness() -> (Harness, String) {
    let h = start().await;
    let key = new_key();
    h.grant(&key, &["registrations:write"]);
    h.set_rpc("data_api_import_registration", |_| {
        json!([{"item": 1, "event_id": EVENT_A, "status": "entered", "reason": null, "replayed": false}])
    });
    (h, key)
}

async fn post(h: &Harness, key: Option<&str>, body: &Value) -> Res {
    h.send(
        Method::POST,
        "/v1/registrations",
        key,
        JSON,
        body.to_string(),
    )
    .await
}

fn import_calls(h: &Harness) -> Vec<Call> {
    h.calls()
        .into_iter()
        .filter(|c| c.fn_name == "data_api_import_registration")
        .collect()
}

#[tokio::test]
async fn registrations_401_without_a_key_and_never_call_the_database() {
    let (h, _) = registrations_harness().await;
    let res = post(&h, None, &response(json!({}))).await;
    assert_eq!(res.status, 401);
    assert!(import_calls(&h).is_empty());
}

#[tokio::test]
async fn registrations_403_a_key_without_the_scope() {
    let (h, _) = registrations_harness().await;
    let other = new_key();
    h.grant_as(
        &other,
        &["predictions:write", "players:read"],
        OTHER_KEY_ID,
        CONSUMER,
    );
    let res = post(&h, Some(&other), &response(json!({}))).await;
    assert_eq!(res.status, 403);
    assert_eq!(
        res.json(),
        json!({"error": "forbidden", "detail": "this key does not carry registrations:write"})
    );
    assert!(import_calls(&h).is_empty());
}

#[tokio::test]
async fn registrations_405_a_get_or_a_delete_naming_post() {
    let (h, key) = registrations_harness().await;
    for method in [Method::GET, Method::DELETE] {
        let res = h
            .request(method, "/v1/registrations", Some(&key), &[])
            .await;
        assert_eq!(res.status, 405);
        assert_eq!(res.header("allow"), Some("POST"));
    }
}

#[tokio::test]
async fn registrations_415_a_body_that_is_not_json() {
    let (h, key) = registrations_harness().await;
    let res = h
        .send(
            Method::POST,
            "/v1/registrations",
            Some(&key),
            &[("content-type", "application/x-www-form-urlencoded")],
            "form_id=x",
        )
        .await;
    assert_eq!(res.status, 415);
}

#[tokio::test]
async fn registrations_400_a_malformed_body_naming_the_field_without_the_database() {
    let (h, key) = registrations_harness().await;
    let cases = [
        (response(json!({"email": "not an email"})), "email"),
        (response(json!({"name": ""})), "name"),
        (response(json!({"form_id": "has spaces in it"})), "form_id"),
        (
            response(json!({"entries": [{"event_id": "nope"}]})),
            "entries[0].event_id",
        ),
        (
            response(json!({"entries": [{"event_id": EVENT_A, "partner_email": "x"}]})),
            "entries[0].partner_email",
        ),
        (
            response(json!({"entries": [{"event_id": EVENT_A, "extra": 1}]})),
            "entries[0].extra",
        ),
        (response(json!({"surprise": true})), "surprise"),
        (
            response(json!({"submitted_at": "yesterday"})),
            "submitted_at",
        ),
        (json!([]), "body"),
        (
            response(json!({"entries": vec![json!({"event_id": EVENT_A}); 21]})),
            "entries",
        ),
    ];
    for (body, field) in cases {
        let res = post(&h, Some(&key), &body).await;
        assert_eq!(res.status, 400, "{field}");
        assert_eq!(res.json(), json!({"error": "bad_request", "field": field}));
    }
    assert!(import_calls(&h).is_empty());
}

#[tokio::test]
async fn registrations_send_the_normalised_response_and_the_key_hash() {
    let (h, key) = registrations_harness().await;
    let res = post(&h, Some(&key), &response(json!({}))).await;
    assert_eq!(res.status, 200);
    assert_eq!(
        res.text(),
        json!({
            "replayed": false,
            "results": [{"index": 1, "event_id": EVENT_A, "status": "entered", "reason": null}],
            "entered": 1, "pending": 0, "refused": 0,
        })
        .to_string()
    );
    let calls = import_calls(&h);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].body["p_key_hash"], json!(hash_key(&key)));
    assert_eq!(
        calls[0].body["p_payload"],
        json!({
            "form_id": "1FAIpQLSexampleForm",
            "response_id": "ACYDBNj-example",
            "submitted_at": "2026-10-08T10:00:00Z",
            "email": "guest.person@example.org",
            "name": "Guest Person",
            "entries": [{"event_id": EVENT_A, "partner_name": "Second Guest"}],
        })
    );
}

#[tokio::test]
async fn registrations_accept_a_response_with_no_entries() {
    let (h, key) = registrations_harness().await;
    let mut body = response(json!({}));
    body.as_object_mut().unwrap().remove("entries");
    let res = post(&h, Some(&key), &body).await;
    assert_eq!(res.status, 200);
    assert_eq!(import_calls(&h)[0].body["p_payload"]["entries"], json!([]));
}

#[tokio::test]
async fn registrations_pass_pending_and_refusals_through_and_drop_other_reasons() {
    let (h, key) = registrations_harness().await;
    h.set_rpc("data_api_import_registration", |_| {
        json!([
            {"item": 1, "event_id": EVENT_A, "status": "pending", "reason": "should not leak", "replayed": false},
            {"item": 2, "event_id": EVENT_B, "status": "refused", "reason": "event_full", "replayed": false},
        ])
    });
    let body = response(json!({"entries": [{"event_id": EVENT_A}, {"event_id": EVENT_B}]}));
    let res = post(&h, Some(&key), &body).await;
    assert_eq!(res.status, 200);
    let answer = res.json();
    assert_eq!(
        answer["results"],
        json!([
            {"index": 1, "event_id": EVENT_A, "status": "pending", "reason": null},
            {"index": 2, "event_id": EVENT_B, "status": "refused", "reason": "event_full"},
        ])
    );
    assert_eq!(
        [&answer["entered"], &answer["pending"], &answer["refused"]],
        [&json!(0), &json!(1), &json!(1)]
    );
}

#[tokio::test]
async fn registrations_say_when_the_answer_is_a_replay() {
    let (h, key) = registrations_harness().await;
    h.set_rpc("data_api_import_registration", |_| {
        json!([{"item": 1, "event_id": EVENT_A, "status": "entered", "reason": null, "replayed": true}])
    });
    let res = post(&h, Some(&key), &response(json!({}))).await;
    assert_eq!(res.json()["replayed"], json!(true));
}

#[tokio::test]
async fn registrations_401_when_the_database_no_longer_accepts_the_key() {
    let (h, key) = registrations_harness().await;
    h.set_rpc("data_api_import_registration", |_| {
        json!([{"item": 0, "event_id": null, "status": "refused", "reason": "key", "replayed": false}])
    });
    assert_eq!(post(&h, Some(&key), &response(json!({}))).await.status, 401);
}

#[tokio::test]
async fn registrations_404_a_form_with_no_active_binding() {
    let (h, key) = registrations_harness().await;
    h.set_rpc("data_api_import_registration", |_| {
        json!([{"item": 0, "event_id": null, "status": "refused", "reason": "not_found", "replayed": false}])
    });
    let res = post(&h, Some(&key), &response(json!({}))).await;
    assert_eq!(res.status, 404);
    assert_eq!(
        res.json(),
        json!({"error": "not_found", "detail": "no active form binding for this key and form_id"})
    );
}

#[tokio::test]
async fn registrations_400_any_other_whole_refusal() {
    let (h, key) = registrations_harness().await;
    h.set_rpc("data_api_import_registration", |_| {
        json!([{"item": 0, "event_id": null, "status": "refused", "reason": "payload", "replayed": false}])
    });
    let res = post(&h, Some(&key), &response(json!({}))).await;
    assert_eq!(res.status, 400);
    assert_eq!(res.json(), json!({"error": "bad_request", "field": "body"}));
}

#[tokio::test]
async fn registrations_never_log_the_body_or_an_email() {
    let (h, key) = registrations_harness().await;
    post(&h, Some(&key), &response(json!({}))).await;
    let logged = h.log_text();
    assert!(!logged.contains("example.org"));
    assert!(!logged.contains("Guest"));
    assert!(logged.contains("/v1/registrations"));
}

#[tokio::test]
async fn registrations_503_when_the_database_fails_without_echoing_anything() {
    let (h, key) = registrations_harness().await;
    h.fail_fn(Some(("data_api_import_registration", 500)));
    let res = post(&h, Some(&key), &response(json!({}))).await;
    assert_eq!(res.status, 503);
    assert!(!h.log_text().contains("example.org"));
}
