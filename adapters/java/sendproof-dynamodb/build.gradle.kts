description = "DynamoDB write guard: an AWS SDK for Java v2 execution interceptor that refuses writes during a Preview and logs commands."

dependencies {
    api(project(":sendproof-core"))
    // The AWS SDK is the host's choice and version.
    compileOnly(platform(rootProject.libs.awssdk.bom))
    compileOnly("software.amazon.awssdk:sdk-core")

    testImplementation(platform(rootProject.libs.awssdk.bom))
    testImplementation(platform(rootProject.libs.spring.boot.bom))
    testImplementation("software.amazon.awssdk:dynamodb")
    testImplementation("software.amazon.awssdk:url-connection-client")
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
