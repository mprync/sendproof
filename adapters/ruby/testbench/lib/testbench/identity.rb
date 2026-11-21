# frozen_string_literal: true

module TestBench
  # The authenticated principal as the workbench shows it, plus the stable subject that owns traces.
  #
  # Build one from a Hash (+name+, +role+, +subject+, +authentication+, +issuer+) or any object responding to those.
  Identity = Data.define(:name, :role, :subject, :authentication, :issuer) do
    # @return [Identity, nil]
    def self.from(value)
      case value
      when nil, false then nil
      when Identity then value
      when Hash
        h = value.transform_keys(&:to_sym)
        new(name: h[:name], role: h[:role], subject: h[:subject], authentication: h[:authentication], issuer: h[:issuer])
      else
        read = ->(reader) { value.respond_to?(reader) ? value.public_send(reader) : nil }
        new(name: read.(:name), role: read.(:role), subject: read.(:subject),
            authentication: read.(:authentication), issuer: read.(:issuer))
      end
    end

    # @return [Owner, nil] nil unless the identity carries a usable stable subject
    def owner(path_base)
      subject = self.subject.to_s
      authentication = (self.authentication || "session").to_s
      issuer = self.issuer.to_s
      return nil if subject.empty? || subject.length > 256 || authentication.length > 256 ||
                    issuer.length > 256 || path_base.to_s.length > 4096

      Owner.new(authentication:, subject:, issuer:, path_base: path_base.to_s)
    end
  end

  # Identifies who may read a trace: the same subject, authentication context and mount.
  Owner = Data.define(:authentication, :subject, :issuer, :path_base)
end
